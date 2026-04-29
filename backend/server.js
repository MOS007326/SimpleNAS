import express from 'express';
import cors from 'cors';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// API route to list block devices (disks)
app.get('/api/disks', async (req, res) => {
    try {
        const { stdout } = await execAsync('lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINTS,FSTYPE,MODEL,SERIAL');
        const data = JSON.parse(stdout);
        // Filter out loop devices and only keep actual disks
        const blockDevices = data.blockdevices.filter(dev => dev.type === 'disk' && !dev.name.startsWith('loop'));
        res.json({ success: true, disks: blockDevices });
    } catch (error) {
        console.error('Error fetching disks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Basic health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`SimpleNAS Backend API listening on port ${PORT}`);
});
