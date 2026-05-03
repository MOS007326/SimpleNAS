import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import si from 'systeminformation';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);
const app = express();
const PORT = 80;

app.use(cors());
app.use(express.json());

// Serve static frontend files from 'dist' directory
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Rebuild the MergerFS pool mount using explicit colon-separated branches.
 * No glob patterns — we list every /mnt/disk_* that is currently mounted.
 */
async function rebuildMergerFsMount() {
    try {
        // Find all data disk mount points in fstab, excluding the pool itself
        const fstab = await fs.readFile('/etc/fstab', 'utf8');
        const potentialMounts = fstab.split('\n')
            .filter(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return false;
                if (trimmed.includes('fuse.mergerfs') || trimmed.includes('/mnt/pool')) return false;
                const fields = trimmed.split(/\s+/);
                return fields[1]?.startsWith('/mnt/disk_');
            })
            .map(line => line.split(/\s+/)[1])
            .filter(Boolean)
            .sort();

        // CRITICAL SAFETY: Only include paths that are ACTUAL hardware mountpoints
        const dataMounts = [];
        for (const mp of potentialMounts) {
            try {
                await execAsync(`mountpoint -q ${mp}`);
                dataMounts.push(mp);
            } catch (e) {
                console.warn(`⚠️ Safety Warning: ${mp} is in fstab but NOT mounted. Excluding from pool to prevent Ghost Drive!`);
            }
        }

        // Remove old pool entry from fstab before rebuilding
        await execAsync(`sed -i '/\\/mnt\\/pool/d' /etc/fstab`);

        if (dataMounts.length === 0) {
            // No data drives — unmount pool if mounted, nothing to do
            try { await execAsync(`umount -l /mnt/pool`); } catch (e) {}
            console.log('No data drives found — pool not mounted.');
            return;
        }

        const branches = dataMounts.join(':');
        // Expert Flags: use_ino, moveonenospc, fsname
        const entry = `${branches} /mnt/pool fuse.mergerfs defaults,allow_other,use_ino,cache.files=partial,dropcacheonclose=true,moveonenospc=true,category.create=mfs,minfreespace=10M,fsname=SimpleNAS_Pool,nofail 0 0`;

        // Write via temp file to avoid shell escaping issues
        await fs.writeFile('/tmp/pool_fstab_entry', entry + '\n');
        await execAsync(`cat /tmp/pool_fstab_entry >> /etc/fstab && rm /tmp/pool_fstab_entry`);

        // Ensure mount point exists and is empty
        try { await execAsync(`umount -l /mnt/pool`); } catch (e) {}
        await execAsync(`mkdir -p /mnt/pool`);

        // 5. MASK THE UNDERLYING FOLDER (Ghost Drive Protection)
        // We set it to 000 so if MergerFS is not mounted, Samba/Users see nothing.
        await execAsync(`chmod 000 /mnt/pool`);

        // 6. Mount the pool
        await execAsync(`mount /mnt/pool`);
        console.log(`MergerFS pool mounted with branches: ${branches}`);
    } catch (err) {
        console.error('Failed to rebuild MergerFS mount:', err.message);
    }
}

/**
 * Dynamically generate /etc/snapraid.conf from mounted disks.
 * Preserves existing disk name assignments (d1, d2, etc.) for stability.
 */
async function generateSnapraidConfig() {
    try {
        let existingConfig = '';
        try { existingConfig = await fs.readFile('/etc/snapraid.conf', 'utf8'); } catch (e) {}

        const existingDisks = {}; // e.g. { 'd1': '/mnt/disk_sdb' }
        const existingParity = [];
        if (existingConfig) {
            existingConfig.split('\n').forEach(line => {
                const match = line.match(/^disk\s+(d[0-9]+)\s+(.+)$/);
                if (match) existingDisks[match[1]] = match[2];

                const pMatch = line.match(/^([2-6]-)?parity\s+(.+)$/);
                if (pMatch) existingParity.push(pMatch[2]);
            });
        }

        // Get actual mount points from the OS
        const { stdout: findmntOut } = await execAsync('findmnt -rn -t ext4 -o TARGET');
        const activeMounts = findmntOut.split('\n').map(m => m.trim()).filter(Boolean);

        const dataDisks = [...new Set(activeMounts.filter(m => m.startsWith('/mnt/disk_')))].sort();
        const parityMounts = [...new Set(activeMounts.filter(m => m.startsWith('/mnt/parity_')))].sort();
        let parityDisks = parityMounts.map(m => `${m}/snapraid.parity`);

        // If no parity disks found, use existing ones (in case they are temporarily unmounted)
        if (parityDisks.length === 0) parityDisks = existingParity;

        // Map currently mounted disks to their existing d-numbers
        const finalDisks = {};
        const unassignedMounts = [];

        // 1. First, keep all existing data disks (even if unmounted!)
        // This ensures SnapRAID knows they are missing rather than deleted.
        for (const [key, path] of Object.entries(existingDisks)) {
            finalDisks[key] = path;
        }

        // 2. Identify new mounts that aren't in the config yet
        dataDisks.forEach(mount => {
            let alreadyConfigured = false;
            for (const path of Object.values(finalDisks)) {
                if (path === mount) {
                    alreadyConfigured = true;
                    break;
                }
            }
            if (!alreadyConfigured) {
                unassignedMounts.push(mount);
            }
        });

        // 3. Assign new d-numbers to new mounts
        let nextDiskNum = 1;
        unassignedMounts.forEach(mount => {
            while (finalDisks[`d${nextDiskNum}`]) {
                nextDiskNum++;
            }
            finalDisks[`d${nextDiskNum}`] = mount;
        });

        let config = `# SnapRAID Configuration\n# Automatically generated by SimpleNAS\n\n`;

        config += `# Parity drives\n`;
        parityDisks.forEach((p, i) => {
            if (i === 0) config += `parity ${p}\n`;
            else config += `${i+1}-parity ${p}\n`;
        });

        config += `\n# Content files (copies of the index)\n`;
        config += `content /var/snapraid.content\n`;
        Object.keys(finalDisks).sort().forEach(dKey => {
            config += `content ${finalDisks[dKey]}/snapraid.content\n`;
        });

        config += `\n# Data disks\n`;
        Object.keys(finalDisks).sort().forEach(dKey => {
            config += `disk ${dKey} ${finalDisks[dKey]}\n`;
        });

        config += `\n# Excludes\n`;
        config += `exclude *.unrecoverable\nexclude /tmp/\nexclude /lost+found/\n`;

        await fs.writeFile('/etc/snapraid.conf', config, 'utf8');
        console.log('Successfully generated /etc/snapraid.conf');
    } catch (err) {
        console.error('Failed to generate snapraid config:', err);
    }
}

// ─── API Routes ────────────────────────────────────────────────────────────────

// List block devices
app.get('/api/disks', async (req, res) => {
    try {
        const { stdout } = await execAsync('lsblk -b -J -o NAME,SIZE,TYPE,MOUNTPOINTS,FSTYPE,MODEL,SERIAL');
        const data = JSON.parse(stdout);
        const blockDevices = data.blockdevices.filter(dev => dev.type === 'disk' && !dev.name.startsWith('loop') && !dev.name.startsWith('sr'));

        const enhancedDisks = await Promise.all(blockDevices.map(async (disk) => {
            let health = 'Unknown';
            let temp = 'Unknown';
            try {
                // M1: S.M.A.R.T. Monitoring
                const { stdout: smart } = await execAsync(`smartctl -A -H -j /dev/${disk.name}`, { timeout: 3000 });
                const smartData = JSON.parse(smart);
                health = smartData.smart_status?.passed ? 'passed' : (smartData.smart_status ? 'FAILING' : 'Unknown');
                temp = smartData.temperature?.current || 'Unknown';
            } catch (e) { /* smartctl failed or not supported */ }

            return {
                ...disk,
                temperature: temp,
                health: health
            };
        }));

        res.json({ success: true, disks: enhancedDisks });
    } catch (error) {
        console.error('Error fetching disks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get MergerFS pool size
app.get('/api/system/storage', async (req, res) => {
    try {
        const fsSize = await si.fsSize();
        const pool = fsSize.find(f => f.mount === '/mnt/pool');
        if (pool) {
            res.json({ success: true, total: pool.size, used: pool.used, use: pool.use });
        } else {
            res.json({ success: true, total: 0, used: 0, use: 0, message: "Pool not mounted" });
        }
    } catch (error) {
        console.error('Error fetching storage:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Live system metrics
app.get('/api/system/stats', async (req, res) => {
    try {
        const [cpu, mem, net] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.networkStats()
        ]);
        const activeNet = net.find(n => n.rx_bytes > 0 || n.tx_bytes > 0) || net[0];

        res.json({
            success: true,
            cpu: cpu.currentLoad,
            memory: { total: mem.total, used: mem.active, percent: (mem.active / mem.total) * 100 },
            network: { rx_sec: activeNet?.rx_sec || 0, tx_sec: activeNet?.tx_sec || 0 }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── Storage Management ────────────────────────────────────────────────────────

// Format a disk and add to pool
app.post('/api/disks/format', async (req, res) => {
    const { disk } = req.body;

    if (!disk || typeof disk !== 'string' || !disk.match(/^[a-z0-9]+$/)) {
        return res.status(400).json({ success: false, error: 'Invalid disk name' });
    }

    const devicePath = `/dev/${disk}`;
    const partitionPath = `/dev/${disk}1`;

    try {
        // Safety check: Ensure it's not the OS drive
        const { stdout: lsblkOut } = await execAsync(`lsblk -J -o NAME,MOUNTPOINTS,SERIAL,LABEL ${devicePath}`);
        const data = JSON.parse(lsblkOut);
        const targetDisk = data.blockdevices[0];

        const isOS = targetDisk.children?.some(part => part.mountpoints?.includes('/'));
        if (isOS) {
            return res.status(403).json({ success: false, error: 'Cannot format the OS drive!' });
        }

        const isMounted = targetDisk.children?.some(part => part.mountpoints?.length > 0 && part.mountpoints[0] !== null);
        if (isMounted) {
            return res.status(403).json({ success: false, error: 'Disk has mounted partitions. Unmount first.' });
        }

        // H4: Safety check: Ensure it's not a parity drive (unless forced)
        const label = targetDisk.children?.[0]?.label || '';
        if (!req.body.force && label.startsWith('parity_')) {
            return res.status(403).json({ 
                success: false, 
                code: 'ROLE_CONFLICT',
                error: 'This drive is already configured as a Parity drive. You cannot add it to the Data pool without clearing it first.' 
            });
        }

        console.log(`Starting format of ${devicePath}...`);
        
        // Ensure unmounted if forcing
        if (req.body.force) {
            try { await execAsync(`umount -l ${devicePath}*`); } catch (e) {}
        }

        // 1. Partition and format
        await execAsync(`parted -s ${devicePath} mklabel gpt`);
        await execAsync(`parted -s ${devicePath} mkpart primary ext4 0% 100%`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await execAsync(`mkfs.ext4 -F -L data_${disk} ${partitionPath}`);
        await execAsync(`tune2fs -m 0 ${partitionPath}`); // Remove reserved blocks to prevent Windows confusion

        // 2. Get UUID and Serial for persistent mounting
        const { stdout: uuidOut } = await execAsync(`blkid -s UUID -o value ${partitionPath}`);
        const uuid = uuidOut.trim();
        
        // C1: VM-Safe Composite ID (Ghost Drive Elimination)
        // Uses serial + device letter to prevent mount point collisions in VMs where
        // all virtual disks may share the same serial (e.g. QEMU_HARDDISK).
        const rawSerial = (targetDisk.serial || '').replace(/[^a-zA-Z0-9]/g, '');
        const serialId = rawSerial ? `${rawSerial}_${disk}` : disk;
        const mountPoint = `/mnt/disk_${serialId}`;
        await execAsync(`mkdir -p ${mountPoint}`);

        // 3. Add to fstab with nofail (remove old entry first)
        await execAsync(`sed -i '\\|${mountPoint}|d' /etc/fstab`);
        const fstabEntry = `UUID=${uuid} ${mountPoint} ext4 defaults,nofail 0 2`;
        await fs.writeFile('/tmp/disk_fstab_entry', fstabEntry + '\n');
        await execAsync(`cat /tmp/disk_fstab_entry >> /etc/fstab && rm /tmp/disk_fstab_entry`);

        // 4. Mount the drive
        await execAsync(`mount ${mountPoint}`);

        // 5. Rebuild MergerFS pool with explicit branches
        await rebuildMergerFsMount();

        // 6. Update SnapRAID config
        await generateSnapraidConfig();

        console.log(`Successfully formatted and added ${devicePath} to pool!`);
        res.json({ success: true, message: `Successfully added ${disk} to the storage pool!` });

    } catch (error) {
        console.error(`Error formatting ${disk}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Formatting failed' });
    }
});

// Format a disk as Parity drive (with size validation)
app.post('/api/disks/parity', async (req, res) => {
    const { disk } = req.body;

    if (!disk || typeof disk !== 'string' || !disk.match(/^[a-z0-9]+$/)) {
        return res.status(400).json({ success: false, error: 'Invalid disk name' });
    }

    const devicePath = `/dev/${disk}`;
    const partitionPath = `/dev/${disk}1`;

    try {
        const { stdout: lsblkOut } = await execAsync(`lsblk -b -J -o NAME,SIZE,MOUNTPOINTS,SERIAL,LABEL`);
        const blockdevices = JSON.parse(lsblkOut).blockdevices;

        const targetDrive = blockdevices.find(d => d.name === disk);
        if (!targetDrive) return res.status(400).json({ success: false, error: 'Drive not found' });

        const isOS = targetDrive.children?.some(part => part.mountpoints?.includes('/'));
        if (isOS) return res.status(403).json({ success: false, error: 'Cannot use the OS drive!' });

        const isMounted = targetDrive.children?.some(part => part.mountpoints?.length > 0 && part.mountpoints[0] !== null);
        if (isMounted) return res.status(403).json({ success: false, error: 'Disk is mounted. Unmount first.' });
        
        // H4: Safety check: Ensure it's not a data drive (unless forced)
        const label = targetDrive.children?.[0]?.label || '';
        if (!req.body.force && label.startsWith('data_')) {
            return res.status(403).json({ 
                success: false, 
                code: 'ROLE_CONFLICT',
                error: 'This drive is already configured as a Data drive. You cannot add it to Parity without clearing it first.' 
            });
        }

        // Ensure unmounted if forcing
        if (req.body.force) {
            try { await execAsync(`umount -l ${devicePath}*`); } catch (e) {}
        }

        // SnapRAID Rule: Parity must be >= largest data drive
        const paritySize = parseInt(targetDrive.size);
        const dataDriveSizes = blockdevices
            .filter(d => d.children?.some(p => p.mountpoints?.some(mp => mp && mp.startsWith('/mnt/disk_'))))
            .map(d => parseInt(d.size));

        if (dataDriveSizes.length > 0) {
            const largestData = Math.max(...dataDriveSizes);
            if (paritySize < largestData) {
                const fmtParity = (paritySize / 1e9).toFixed(1);
                const fmtData = (largestData / 1e9).toFixed(1);
                return res.status(400).json({
                    success: false,
                    error: `Parity drive (${fmtParity} GB) must be at least as large as your biggest data drive (${fmtData} GB). This is a SnapRAID requirement.`
                });
            }
        }

        console.log(`Configuring parity on ${devicePath}...`);

        await execAsync(`parted -s ${devicePath} mklabel gpt`);
        await execAsync(`parted -s ${devicePath} mkpart primary ext4 0% 100%`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await execAsync(`mkfs.ext4 -F -m 0 -L parity_${disk} ${partitionPath}`);

        const { stdout: uuidOut } = await execAsync(`blkid -s UUID -o value ${partitionPath}`);
        const uuid = uuidOut.trim();

        // C1: VM-Safe Composite ID for parity drive
        const rawSerial = (targetDrive.serial || '').replace(/[^a-zA-Z0-9]/g, '');
        const serialId = rawSerial ? `${rawSerial}_${disk}` : disk;
        const mountPoint = `/mnt/parity_${serialId}`;
        await execAsync(`mkdir -p ${mountPoint}`);

        // Add to fstab with nofail
        await execAsync(`sed -i '\\|${mountPoint}|d' /etc/fstab`);
        const fstabEntry = `UUID=${uuid} ${mountPoint} ext4 defaults,nofail 0 2`;
        await fs.writeFile('/tmp/parity_fstab_entry', fstabEntry + '\n');
        await execAsync(`cat /tmp/parity_fstab_entry >> /etc/fstab && rm /tmp/parity_fstab_entry`);
        await execAsync(`mount ${mountPoint}`);

        await generateSnapraidConfig();

        console.log(`Successfully set up ${devicePath} as Parity!`);
        res.json({ success: true, message: `Successfully set ${disk} as Parity drive!` });

    } catch (error) {
        console.error(`Error setting parity ${disk}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Parity setup failed' });
    }
});

// Remove a drive from the pool (for drive replacement workflow)
app.post('/api/disks/remove', async (req, res) => {
    const { disk } = req.body;

    if (!disk || typeof disk !== 'string' || !disk.match(/^[a-z0-9]+$/)) {
        return res.status(400).json({ success: false, error: 'Invalid disk name' });
    }

    try {
        // 1. Find where this disk is actually mounted
        const { stdout: lsblkOut } = await execAsync(`lsblk -b -J -o NAME,MOUNTPOINTS /dev/${disk}`);
        const diskData = JSON.parse(lsblkOut).blockdevices[0];
        
        let mountPoint = null;
        if (diskData.children) {
            for (const child of diskData.children) {
                if (child.mountpoints && child.mountpoints.length > 0 && child.mountpoints[0]) {
                    mountPoint = child.mountpoints[0];
                    break;
                }
            }
        }

        if (!mountPoint) {
            return res.status(400).json({ success: false, error: `Drive ${disk} is not currently mounted.` });
        }

        const isData = mountPoint.startsWith('/mnt/disk_');
        const isParity = mountPoint.startsWith('/mnt/parity_');

        if (!isData && !isParity) {
             return res.status(400).json({ success: false, error: `Drive ${disk} is mounted at ${mountPoint}, which is not a managed SimpleNAS path.` });
        }

        // 2. Find SnapRAID disk name (d1, d2, etc.) if it's a data disk
        let snapraidDiskName = null;
        if (isData) {
            try {
                const config = await fs.readFile('/etc/snapraid.conf', 'utf8');
                const match = config.match(new RegExp(`^disk\\s+(d\\d+)\\s+${mountPoint.replace(/\//g, '\\/')}`, 'm'));
                if (match) snapraidDiskName = match[1];
            } catch (e) {}
        }

        // 3. Unmount the drive
        await execAsync(`umount -l ${mountPoint}`);
        console.log(`Unmounted ${mountPoint}`);

        // 4. Remove fstab entry for this drive
        await execAsync(`sed -i '\\|${mountPoint}|d' /etc/fstab`);

        // 5. Update system configurations
        if (isData) {
            await rebuildMergerFsMount();
            // DO NOT call generateSnapraidConfig here. 
            // We want the drive to stay in snapraid.conf but be unmounted 
            // so SnapRAID detects it as 'missing' for recovery.
        } else if (isParity) {
            await generateSnapraidConfig(); 
            // We DO want to update config for parity swap/removal.
        }

        console.log(`Removed ${isData ? 'Data' : 'Parity'} drive ${disk} from system.`);
        res.json({
            success: true,
            message: `Drive ${disk} (${isData ? 'Data' : 'Parity'}) removed. You can now physically replace it.`,
            snapraidDiskName
        });

    } catch (error) {
        console.error(`Error removing ${disk}:`, error);
        res.status(500).json({ success: false, error: error.message || 'Remove failed' });
    }
});

// ─── Samba Shares ──────────────────────────────────────────────────────────────

app.get('/api/shares', async (req, res) => {
    try {
        const { stdout: conf } = await execAsync('cat /etc/samba/smb.conf');
        const shares = [];
        const lines = conf.split('\n');
        let currentShare = null;

        for (const line of lines) {
            const match = line.match(/^\[(.*)\]$/);
            if (match) {
                if (currentShare) shares.push(currentShare);
                currentShare = { name: match[1], enabled: true, path: '' };
            } else if (currentShare && line.trim().startsWith('path =')) {
                currentShare.path = line.split('=')[1].trim();
            }
        }
        if (currentShare) shares.push(currentShare);

        // Find our managed share
        const managedShare = shares.find(s => s.path === '/mnt/pool') || { name: 'SimpleNAS_Pool', path: '/mnt/pool', enabled: false };

        res.json({ success: true, shares, managedShare });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

async function applySambaConfig(shareName, isPublic, password = null) {
    const hostname = os.hostname();
    // 1. Prepare base config (cleaner than default)
    const baseConfig = `[global]
   workgroup = WORKGROUP
   netbios name = ${hostname.toUpperCase().substring(0, 15)}
   server string = ${hostname} SimpleNAS
   server role = standalone server
   map to guest = bad user
   log file = /var/log/samba/log.%m
   max log size = 1000
   logging = file
   panic action = /usr/share/samba/panic-action %d
   obey pam restrictions = yes
   unix password sync = yes
   passwd program = /usr/bin/passwd %u
   passwd chat = *Enter\\snew\\s*\\spassword:* %n\\n *Retype\\snew\\s*\\spassword:* %n\\n *password\\supdated\\ssuccessfully* .
   pam password change = yes
   usershare allow guests = yes
`;
    let shareConfig = `
[${shareName}]
   path = /mnt/pool
   browseable = yes
   read only = no
   create mask = 0777
   directory mask = 0777
   force user = root
   veto files = /snapraid.content/lost+found/
   delete veto files = no
`;

    if (isPublic) {
        shareConfig += `   guest ok = yes\n`;
    } else {
        shareConfig += `   guest ok = no\n   valid users = simplenas\n`;
        if (password) {
            await execAsync(`id -u simplenas || useradd -M -s /usr/sbin/nologin simplenas`);
            await execAsync(`(echo "${password}"; echo "${password}") | smbpasswd -s -a simplenas`);
        }
    }

    await fs.writeFile('/etc/samba/smb.conf', baseConfig + shareConfig);
    await execAsync(`systemctl restart smbd nmbd`);

    // Ensure the pool is actually mounted before the user tries to use the share
    await rebuildMergerFsMount();
}

app.post('/api/shares/enable', async (req, res) => {
    const { shareName = 'SimpleNAS_Pool' } = req.body;
    try {
        await applySambaConfig(shareName, true);
        res.json({ success: true, message: `Public share [${shareName}] enabled!` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/shares/credentials', async (req, res) => {
    const { password, shareName = 'SimpleNAS_Pool' } = req.body;
    if (!password || password.length < 4) {
        return res.status(400).json({ success: false, error: 'Password must be at least 4 characters' });
    }

    try {
        await applySambaConfig(shareName, false, password);
        res.json({ success: true, message: `Private share [${shareName}] enabled for user 'simplenas'.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── SnapRAID Management ───────────────────────────────────────────────────────

app.post('/api/snapraid/sync', async (req, res) => {
    const { force = false, full = false, forceUuid = false } = req.body;
    try {
        // H2: Pre-sync mount verification
        const config = await fs.readFile('/etc/snapraid.conf', 'utf8');
        const configuredDisks = config.split('\n')
            .filter(l => l.startsWith('disk '))
            .map(l => l.split(/\s+/)[2]);

        for (const mp of configuredDisks) {
            try {
                await execAsync(`mountpoint -q ${mp}`);
            } catch (e) {
                return res.status(400).json({
                    success: false,
                    error: `Safety Error: Drive at ${mp} is not mounted! Syncing now would risk your parity. Check your cables.`
                });
            }
        }

        let cmd = 'snapraid';
        if (full) cmd += ' --force-empty --force-full';
        else if (force) cmd += ' --force-empty';
        
        if (forceUuid || full || force) cmd += ' --force-uuid';
        
        cmd += ' sync';
        
        await execAsync(`nohup ${cmd} > /var/log/snapraid_sync.log 2>&1 &`);
        res.json({ success: true, message: `SnapRAID sync started ${full ? '(FULL REBUILD)' : (force ? '(FORCED)' : '')} in the background.` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/snapraid/status', async (req, res) => {
    try {
        // 1. Check if SnapRAID is currently running
        const { stdout: isRunningStr } = await execAsync(`pgrep snapraid || echo ""`);
        const running = isRunningStr.trim().length > 0;

        // 2. Read the last sync log (more lines for safety)
        const { stdout: logContent } = await execAsync(`tail -n 500 /var/log/snapraid_sync.log || echo "No sync log found."`);

        // 3. Calculate progress if running
        let progress = 0;
        const matches = logContent.match(/(\d+)%/g);
        if (matches) {
            progress = parseInt(matches[matches.length - 1]);
        }

        // 4. Perform a live 'diff' check if NOT running to see if sync is ACTUALLY needed
        // Exit code 0 = No changes, 2 = Changes detected.
        let inSync = false;
        if (!running) {
            try {
                await execAsync('snapraid diff');
                inSync = true; // Exit code 0
            } catch (e) {
                // Exit code 2 or other error means not in sync
                inSync = false;
            }
        } else {
            // If running, we check if the log ALREADY says Everything OK (unlikely if running but safe)
            inSync = logContent.includes('Everything OK') || logContent.includes('100% completed');
        }

        res.json({ 
            success: true, 
            log: logContent, 
            running, 
            progress,
            inSync 
        });
    } catch (error) {
        res.json({ success: true, log: 'Error fetching status', running: false, progress: 0, inSync: false });
    }
});

app.post('/api/snapraid/cron', async (req, res) => {
    const { enable, time } = req.body;
    try {
        const scriptPath = '/usr/local/bin/simplenas-snapraid.sh';
        const cronPath = '/etc/cron.d/simplenas-snapraid';

        if (enable) {
            let hour = '2';
            let minute = '0';
            if (time && time.includes(':')) {
                const parts = time.split(':');
                hour = parseInt(parts[0], 10);
                minute = parseInt(parts[1], 10);
            }

            const cronScript = `#!/bin/bash
LOG="/var/log/snapraid_sync.log"
# 1. Pre-flight: verify all configured disks are mounted
MISSING=$(snapraid status 2>&1 | grep -c "WARNING! Disk")
if [ "$MISSING" -gt 0 ]; then
    echo "$(date) ABORTED: $MISSING disk(s) missing. Not syncing." >> $LOG
    exit 1
fi
# 2. Dry-run to check delete threshold (50% safety valve)
DELETED=$(snapraid diff 2>&1 | grep -oP '^\\s+\\K\\d+(?= removed)')
THRESHOLD=50
if [ "\${DELETED:-0}" -gt "$THRESHOLD" ]; then
    echo "$(date) ABORTED: $DELETED files deleted (threshold: $THRESHOLD)." >> $LOG
    exit 1
fi
# 3. Safe to sync
snapraid sync >> $LOG 2>&1
# 4. Weekly scrub (check 8% of data for bitrot on Sundays)
DAY=$(date +%u)
if [ "$DAY" -eq 7 ]; then
    snapraid scrub -p 8 -o 30 >> $LOG 2>&1
fi
`;
            await fs.writeFile(scriptPath, cronScript, { mode: 0o755 });

            const cronJob = `${minute} ${hour} * * * root ${scriptPath}\n`;
            await fs.writeFile(cronPath, cronJob, { mode: 0o644 });

            await execAsync(`rm -f /etc/cron.daily/simplenas-snapraid`);

            res.json({ success: true, message: `Robust daily sync scheduled for ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}.` });
        } else {
            await execAsync(`rm -f ${cronPath} ${scriptPath}`);
            res.json({ success: true, message: 'Automated SnapRAID sync disabled.' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SnapRAID Health — detect missing disks
app.get('/api/snapraid/health', async (req, res) => {
    try {
        let existingConfig = '';
        try { existingConfig = await fs.readFile('/etc/snapraid.conf', 'utf8'); } catch (e) {
            return res.json({ success: true, missingDisks: [] });
        }

        const missingDisks = [];
        let parityCount = 0;
        const lines = existingConfig.split('\n');
        for (const line of lines) {
            // Count parity drives
            if (line.match(/^([2-6]-)?parity\s+/)) {
                parityCount++;
            }

            // Check for missing data disks
            const match = line.match(/^disk\s+(d[0-9]+)\s+(.+)$/);
            if (match) {
                const diskName = match[1];
                const mountPoint = match[2];
                try {
                    await execAsync(`mountpoint -q ${mountPoint}`);
                } catch (e) {
                    missingDisks.push({ name: diskName, mountPoint });
                }
            }
        }
        
        const isRecoverable = missingDisks.length <= parityCount;
        res.json({ success: true, missingDisks, parityCount, isRecoverable });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// SnapRAID Fix — rebuild data onto a replacement drive
app.post('/api/snapraid/fix', async (req, res) => {
    const { missingDiskName, newDiskDevice } = req.body;
 
    if (!missingDiskName || !newDiskDevice || !newDiskDevice.match(/^[a-z0-9]+$/)) {
        return res.status(400).json({ success: false, error: 'Invalid parameters' });
    }
 
    const devicePath = `/dev/${newDiskDevice}`;
    const partitionPath = `/dev/${newDiskDevice}1`;
 
    try {
        // C4: Size Validation
        const { stdout: lsblkOut } = await execAsync(`lsblk -b -J -o NAME,SIZE,SERIAL`);
        const blockdevices = JSON.parse(lsblkOut).blockdevices;
        const newDisk = blockdevices.find(d => d.name === newDiskDevice);
        
        if (!newDisk) return res.status(400).json({ success: false, error: 'Replacement drive not found' });
        
        // Get the size of the largest existing parity file to estimate minimum required size
        const { stdout: snapStatus } = await execAsync(`snapraid status`);
        const sizeMatch = snapStatus.match(/(\d+) GiB of parity/);
        if (sizeMatch) {
            const requiredBytes = parseInt(sizeMatch[1]) * 1024 * 1024 * 1024;
            if (parseInt(newDisk.size) < requiredBytes) {
                return res.status(400).json({
                    success: false, 
                    error: `The replacement drive is too small. It must be at least ${sizeMatch[1]} GiB to fit the parity data.` 
                });
            }
        }

        // Format the new disk
        await execAsync(`parted -s ${devicePath} mklabel gpt`);
        await execAsync(`parted -s ${devicePath} mkpart primary ext4 0% 100%`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await execAsync(`mkfs.ext4 -F -L data_${newDiskDevice} ${partitionPath}`);
        await execAsync(`tune2fs -m 0 ${partitionPath}`); // Remove reserved blocks to prevent Windows confusion

        const { stdout: uuidOut } = await execAsync(`blkid -s UUID -o value ${partitionPath}`);
        const uuid = uuidOut.trim();

        const mountPoint = `/mnt/disk_${newDiskDevice}`;
        await execAsync(`mkdir -p ${mountPoint}`);

        // Add to fstab with nofail
        await execAsync(`sed -i '\\|${mountPoint}|d' /etc/fstab`);
        const fstabEntry = `UUID=${uuid} ${mountPoint} ext4 defaults,nofail 0 2`;
        await fs.writeFile('/tmp/fix_fstab_entry', fstabEntry + '\n');
        await execAsync(`cat /tmp/fix_fstab_entry >> /etc/fstab && rm /tmp/fix_fstab_entry`);
        await execAsync(`mount ${mountPoint}`);

        // Rebuild pool to include the replacement disk
        await rebuildMergerFsMount();

        // Update snapraid.conf to point the missing disk name to the new mountpoint
        let config = await fs.readFile('/etc/snapraid.conf', 'utf8');
        const configLines = config.split('\n');
        const newLines = configLines.map(line => {
            if (line.startsWith(`disk ${missingDiskName} `)) {
                return `disk ${missingDiskName} ${mountPoint}`;
            }
            return line;
        });
        await fs.writeFile('/etc/snapraid.conf', newLines.join('\n'), 'utf8');

        // Start the fix process in the background with force flags
        await execAsync(`nohup snapraid fix -d ${missingDiskName} --force-uuid --force-device > /var/log/snapraid_sync.log 2>&1 &`);

        res.json({ success: true, message: `Recovery started! Rebuilding data onto ${newDiskDevice}.` });
    } catch (error) {
        console.error('Error starting fix:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// M3: Undelete Capability
app.post('/api/snapraid/undelete', async (req, res) => {
    try {
        await execAsync(`nohup snapraid fix -m > /var/log/snapraid_sync.log 2>&1 &`);
        res.json({ success: true, message: 'Recovery of deleted files started in the background!' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ─── General ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Fallback to index.html for React routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`SimpleNAS Backend API listening on port ${PORT}`);
});
