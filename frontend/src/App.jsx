import { useState, useEffect } from 'react';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [disks, setDisks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState('');
  
  const [sysStats, setSysStats] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  
  const [snapraidStatus, setSnapraidStatus] = useState({ running: false, log: '', progress: 0 });
  const [cronEnabled, setCronEnabled] = useState(false);
  const [cronTime, setCronTime] = useState('02:00');

  const [missingDisks, setMissingDisks] = useState([]);
  const [recoveryModalOpen, setRecoveryModalOpen] = useState(false);
  const [selectedMissingDisk, setSelectedMissingDisk] = useState('');
  const [selectedReplacementDisk, setSelectedReplacementDisk] = useState('');
  const [shareName, setShareName] = useState('SimpleNAS_Pool');




  useEffect(() => {
    if (activeTab === 'storage') {
      fetchDisks();
      fetchSnapraidStatus();
      const interval = setInterval(fetchSnapraidStatus, 5000);
      return () => clearInterval(interval);
    }
    if (activeTab === 'dashboard') {
      fetchDashboardStats();
      const interval = setInterval(fetchDashboardStats, 2000);
      return () => clearInterval(interval);
    }
    if (activeTab === 'shares') {
      fetchShares();
    }
  }, [activeTab]);

  const fetchDashboardStats = async () => {
    try {
      const [statsRes, storageRes] = await Promise.all([
        fetch(`/api/system/stats`),
        fetch(`/api/system/storage`)
      ]);
      const statsData = await statsRes.json();
      const storageData = await storageRes.json();
      
      if (statsData.success) setSysStats(statsData);
      if (storageData.success) setStorageStats(storageData);
    } catch (e) {
      console.error("Error fetching stats", e);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes || bytes === 0) return '0 GB';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const fetchDisks = async () => {
    setLoading(true);
    try {
      // The backend runs on port 3001
      const res = await fetch(`/api/disks`);
      const data = await res.json();
      if (data.success) {
        setDisks(data.disks);
      }
      
      const healthRes = await fetch(`/api/snapraid/health`);
      const healthData = await healthRes.json();
      if (healthData.success) {
        setMissingDisks(healthData.missingDisks);
      }
    } catch (error) {
      console.error("Failed to fetch disks", error);
    }
    setLoading(false);
  };

  const fetchSnapraidStatus = async () => {
    try {
      const res = await fetch(`/api/snapraid/status`);
      const data = await res.json();
      if (data.success) {
        setSnapraidStatus({ running: data.running, log: data.log });
      }
    } catch (error) {
      console.error("Failed to fetch SnapRAID status", error);
    }
  };

  const handleSnapraidSync = async (force = false, full = false) => {
    try {
      const res = await fetch(`/api/snapraid/sync`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force, full })
      });
      const data = await res.json();
      if (data.success) {
        alert(full ? "Full Rebuild started!" : (force ? "Forced Sync started!" : "Sync started!"));
        fetchSnapraidStatus();
      } else {
        alert("Failed to start sync: " + data.error);
      }
    } catch (e) {
      alert("Error starting sync.");
    }
  };

  const handleSnapraidCron = async (enable) => {
    try {
      const res = await fetch(`/api/snapraid/cron`, { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable, time: cronTime })
      });
      const data = await res.json();
      if (data.success) {
        setCronEnabled(enable);
        alert(data.message);
      } else {
        alert("Failed to configure cron: " + data.error);
      }
    } catch (e) {
      alert("Error configuring cron.");
    }
  };

  const handleFormat = async (diskName, force = false) => {
    if (!force && !window.confirm(`WARNING: Are you sure you want to format /dev/${diskName}?\n\nALL DATA ON THIS DRIVE WILL BE PERMANENTLY ERASED!`)) {
      return;
    }
    
    try {
      const res = await fetch(`/api/disks/format`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disk: diskName, force })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        fetchDisks(); // Refresh the disk list
      } else if (data.code === 'ROLE_CONFLICT') {
        if (window.confirm(`${data.error}\n\nDo you want to FORCE WIPE this drive and re-purpose it for the Data Pool?`)) {
          handleFormat(diskName, true);
        }
      } else {
        alert('Format failed: ' + data.error);
      }
    } catch (error) {
      console.error("Format error", error);
      alert('An error occurred while formatting.');
    }
  };

  const handleParity = async (diskName, force = false) => {
    if (!force && !window.confirm(`WARNING: Are you sure you want to format /dev/${diskName} as the PARITY drive?\n\nALL DATA ON THIS DRIVE WILL BE PERMANENTLY ERASED!`)) {
      return;
    }
    
    try {
      const res = await fetch(`/api/disks/parity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disk: diskName, force })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        fetchDisks(); // Refresh the disk list
      } else if (data.code === 'ROLE_CONFLICT') {
        if (window.confirm(`${data.error}\n\nDo you want to FORCE WIPE this drive and re-purpose it for Parity?`)) {
          handleParity(diskName, true);
        }
      } else {
        alert('Parity setup failed: ' + data.error);
      }
    } catch (error) {
      console.error("Parity setup error", error);
      alert('An error occurred while setting up parity.');
    }
  };

  const handleRecover = async () => {
    if (!selectedMissingDisk || !selectedReplacementDisk) return;
    if (!window.confirm(`Are you sure you want to completely erase /dev/${selectedReplacementDisk} and rebuild data onto it?`)) return;

    setLoading(true);
    setRecoveryModalOpen(false);
    try {
      const res = await fetch(`/api/snapraid/fix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ missingDiskName: selectedMissingDisk, newDiskDevice: selectedReplacementDisk })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        fetchSnapraidStatus();
        fetchDisks(); // Refresh health status and disk list immediately
      } else {
        alert("Failed to start recovery: " + data.error);
      }
    } catch (e) {
      alert("Error starting recovery.");
    }
    setLoading(false);
  };

  const handleUndelete = async () => {
    if (!window.confirm("Try to recover accidentally deleted files? This will look through the parity data and restore files that are missing from the disks.")) return;
    try {
      const res = await fetch(`/api/snapraid/undelete`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        alert(data.message);
        fetchSnapraidStatus();
      } else {
        alert("Undelete failed: " + data.error);
      }
    } catch (e) {
      alert("Error starting undelete.");
    }
  };

  const fetchShares = async () => {
    try {
      const res = await fetch('/api/shares');
      const data = await res.json();
      if (data.success && data.managedShare) {
        setShareName(data.managedShare.name);
      }
    } catch (e) {
      console.error("Error fetching shares", e);
    }
  };

  const handleRemoveFromPool = async (diskName) => {
    if (!window.confirm(`Remove ${diskName} from the pool?\n\nThe drive will be unmounted. You can then physically swap it and rebuild from parity.`)) return;
    setLoading(true);
    try {
      const res = await fetch('/api/disks/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disk: diskName })
      });
      const data = await res.json();
      if (data.success) {
        alert(data.message + (data.snapraidDiskName ? `\n\nSnapRAID disk ID: ${data.snapraidDiskName} — needed for rebuild.` : ''));
        fetchDisks();
      } else {
        alert('Remove failed: ' + data.error);
      }
    } catch (e) {
      alert('Error removing drive from pool.');
    }
    setLoading(false);
  };


  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center font-bold shadow-lg shadow-indigo-500/20">
              S
            </div>
            <h1 className="font-bold text-xl tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400">SimpleNAS</h1>
          </div>
          <nav className="flex gap-1 bg-slate-800/50 p-1 rounded-lg border border-slate-700/50">
            {['dashboard', 'storage', 'shares'].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${
                  activeTab === tab 
                    ? 'bg-slate-700 text-white shadow-sm' 
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        
        {/* Dashboard Tab */}
        {activeTab === 'dashboard' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">System Overview</h2>
              <p className="text-slate-400 mt-1">Real-time health and storage metrics.</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">CPU Usage</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-emerald-400">
                    {sysStats ? sysStats.cpu.toFixed(1) : '0'}%
                  </span>
                </div>
                <div className="w-full bg-slate-700/50 rounded-full h-2 mt-4 overflow-hidden">
                  <div className="bg-emerald-500 h-2 rounded-full transition-all duration-500" style={{width: `${sysStats?.cpu || 0}%`}}></div>
                </div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Memory (RAM)</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-amber-400">
                    {sysStats ? sysStats.memory.percent.toFixed(1) : '0'}%
                  </span>
                  <span className="text-sm text-slate-500">
                    {sysStats ? formatBytes(sysStats.memory.used) : '0 GB'}
                  </span>
                </div>
                <div className="w-full bg-slate-700/50 rounded-full h-2 mt-4 overflow-hidden">
                  <div className="bg-amber-500 h-2 rounded-full transition-all duration-500" style={{width: `${sysStats?.memory.percent || 0}%`}}></div>
                </div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Storage Capacity</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-slate-200">
                    {storageStats ? formatBytes(storageStats.used) : '0 GB'}
                  </span>
                  <span className="text-sm font-medium text-slate-500">
                    / {storageStats ? formatBytes(storageStats.total) : '0 GB'}
                  </span>
                </div>
                <div className="w-full bg-slate-700/50 rounded-full h-2 mt-4 overflow-hidden">
                  <div className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full transition-all duration-500" style={{width: `${storageStats?.use || 0}%`}}></div>
                </div>
              </div>
            </div>
            
            {/* Array Health & Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-4">Array Health Status</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">Disk Connectivity</span>
                    <span className={`text-sm font-bold ${missingDisks.length === 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {missingDisks.length === 0 ? '✓ ALL DRIVES ONLINE' : `⚠️ ${missingDisks.length} DRIVE(S) MISSING`}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">Parity Status</span>
                    <span className={`text-sm font-bold ${snapraidStatus.log && (snapraidStatus.log.includes('Everything OK') || snapraidStatus.log.includes('100% completed')) ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {snapraidStatus.log && (snapraidStatus.log.includes('Everything OK') || snapraidStatus.log.includes('100% completed')) ? '✓ PROTECTED' : '⚠️ SYNC RECOMMENDED'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-300">Hardware SMART</span>
                    <span className={`text-sm font-bold ${disks.every(d => d.health === 'passed' || d.health === 'Unknown') ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {disks.every(d => d.health === 'passed' || d.health === 'Unknown') ? '✓ HEALTHY' : '⚠️ HARDWARE ALERT'}
                    </span>
                  </div>
                </div>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6">
                 <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider mb-4">Network Activity</h3>
                 <div className="flex justify-around">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-400">{sysStats ? formatBytes(sysStats.network.rx_sec) : '0 B'}/s</div>
                      <div className="text-xs text-slate-500 uppercase mt-1">Download</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-purple-400">{sysStats ? formatBytes(sysStats.network.tx_sec) : '0 B'}/s</div>
                      <div className="text-xs text-slate-500 uppercase mt-1">Upload</div>
                    </div>
                 </div>
              </div>
            </div>

          </div>
        )}

        {/* Storage Tab */}
        {activeTab === 'storage' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="flex justify-between items-end">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Storage Manager</h2>
                <p className="text-slate-400 mt-1">Format drives, add them to the pool, and configure parity.</p>
              </div>
              <button 
                onClick={fetchDisks}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
              >
                {loading ? 'Scanning...' : 'Rescan Drives'}
              </button>
            </div>

            {snapraidStatus.running && (
              <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 mb-8 flex items-center justify-between shadow-lg shadow-indigo-500/5">
                <div className="flex items-center gap-4">
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-pulse"></div>
                  <div>
                    <div className="text-indigo-400 font-bold text-sm">System Task in Progress</div>
                    <div className="text-slate-400 text-xs">SnapRAID is currently sync/rebuilding...</div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <div className="text-indigo-400 font-mono text-sm">{snapraidStatus.progress}%</div>
                  <div className="w-48 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-indigo-500 transition-all duration-500" 
                      style={{ width: `${snapraidStatus.progress}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            )}

            {missingDisks.length > 0 && (
              <div className="bg-rose-500/10 border border-rose-500/50 rounded-xl p-6 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-rose-400 flex items-center gap-2">
                    <span className="relative flex h-3 w-3"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-rose-500"></span></span>
                    Critical Array Degradation Detected!
                  </h3>
                  <p className="text-sm text-rose-300/80 mt-1">
                    {missingDisks.length} drive(s) have failed or are missing from the array: {missingDisks.map(d => `${d.name} (${d.mountPoint})`).join(', ')}. Data is currently unprotected.
                  </p>
                </div>
                <button 
                  onClick={() => setRecoveryModalOpen(true)}
                  className="px-6 py-2.5 bg-rose-500 hover:bg-rose-600 text-white rounded-lg text-sm font-bold shadow-lg shadow-rose-500/20 transition-colors"
                >
                  Recover Data
                </button>
              </div>
            )}

            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden">
              {loading ? (
                <div className="p-12 text-center text-slate-400">Scanning hardware...</div>
              ) : disks.length === 0 ? (
                <div className="p-12 text-center text-slate-400">No disks found.</div>
              ) : (
                <div className="divide-y divide-slate-700/50">
                  {disks.map((disk) => {
                    // Check if it's the OS drive (has a partition mounted at / or /boot)
                    const isOS = disk.children?.some(part => part.mountpoints?.includes('/'));
                    
                    // Check if it's mounted in the pool
                    const isInPool = disk.children?.some(part => part.mountpoints?.some(mp => mp?.startsWith('/mnt/disk_')));
                    
                    // Check if it's a parity drive
                    const isParity = disk.children?.some(part => part.mountpoints?.some(mp => mp?.startsWith('/mnt/parity_')));

                    return (
                      <div key={disk.name} className="p-6 flex items-center justify-between hover:bg-slate-800/80 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl shadow-inner ${isOS ? 'bg-slate-800 text-slate-500 border border-slate-700' : isParity ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : isInPool ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'}`}>
                            🖴
                          </div>
                          <div>
                            <h3 className="font-semibold text-lg flex items-center gap-2">
                              {disk.name}
                              {isOS && <span className="text-[10px] uppercase tracking-wider bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">OS Drive</span>}
                              {isInPool && <span className="text-[10px] uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-0.5 rounded-full">In Pool</span>}
                              {isParity && <span className="text-[10px] uppercase tracking-wider bg-amber-500/20 text-amber-400 border border-amber-500/30 px-2 py-0.5 rounded-full">Parity</span>}
                            </h3>
                            <p className="text-sm text-slate-400 flex gap-3">
                              <span>{formatBytes(disk.size)}</span>
                              <span>•</span>
                              <span>{disk.model || 'Unknown Model'}</span>
                              {disk.temperature && disk.temperature !== 'Unknown' && (
                                <>
                                  <span>•</span>
                                  <span className="text-rose-400">{disk.temperature}°C</span>
                                </>
                              )}
                              {disk.health && disk.health !== 'Unknown' && (
                                <>
                                  <span>•</span>
                                  <span className={disk.health === 'passed' ? 'text-emerald-400' : 'text-rose-400'}>
                                    SMART: {disk.health.toUpperCase()}
                                  </span>
                                </>
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {isOS ? (
                            <button disabled className="px-4 py-2 bg-slate-800/50 text-slate-500 rounded-lg text-sm font-medium cursor-not-allowed">
                              System Drive (Locked)
                            </button>
                          ) : isInPool ? (
                             <div className="flex gap-2">
                               <button disabled className="px-4 py-2 bg-emerald-500/5 text-emerald-500/50 border border-emerald-500/10 rounded-lg text-sm font-medium cursor-not-allowed flex items-center gap-2">
                                 In Pool
                               </button>
                               <button
                                 onClick={() => handleRemoveFromPool(disk.name)}
                                 className="px-4 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-lg text-sm font-medium transition-colors"
                               >
                                 Remove
                               </button>
                             </div>
                          ) : isParity ? (
                             <button disabled className="px-4 py-2 bg-amber-500/5 text-amber-500/50 border border-amber-500/10 rounded-lg text-sm font-medium cursor-not-allowed flex items-center gap-2">
                                Parity Drive
                             </button>
                          ) : (
                            <>
                              <button 
                                onClick={() => handleFormat(disk.name)}
                                className="px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-lg text-sm font-medium transition-colors"
                              >
                                Add to Data Pool
                              </button>
                              <button 
                                onClick={() => handleParity(disk.name)}
                                className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors"
                              >
                                Set as Parity
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SnapRAID Management Panel */}
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden mt-8">
              <div className="p-6 border-b border-slate-700/50 flex justify-between items-center">
                <div>
                  <h3 className="text-lg font-bold">SnapRAID Protection</h3>
                  <p className="text-sm text-slate-400">Manage parity synchronization and automation.</p>
                </div>
                <div className="flex gap-3 items-center">
                  <div className="flex items-center gap-2 bg-slate-900/50 px-3 py-1.5 rounded-lg border border-slate-700/50">
                    <span className="text-xs text-slate-400">Daily at:</span>
                    <input 
                      type="time" 
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                      disabled={cronEnabled}
                      className="bg-transparent text-sm text-slate-200 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <button 
                    onClick={() => handleSnapraidCron(!cronEnabled)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${cronEnabled ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}
                  >
                    {cronEnabled ? '✓ Daily Sync Enabled' : 'Enable Daily Sync'}
                  </button>
                  <button 
                    onClick={() => handleSnapraidSync()}
                    disabled={snapraidStatus.running}
                    className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 disabled:bg-indigo-500/50 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-indigo-500/20"
                  >
                    {snapraidStatus.running ? 'Sync Running...' : 'Sync Now'}
                  </button>
                  {!snapraidStatus.running && (
                    <button 
                      onClick={handleUndelete}
                      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-sm font-medium transition-colors"
                    >
                      🩹 Undelete Files
                    </button>
                  )}
                  {!snapraidStatus.running && snapraidStatus.log && snapraidStatus.log.includes('--force-empty') && (
                    <button 
                      onClick={() => handleSnapraidSync(true)}
                      className="px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-rose-500/20"
                    >
                      ⚠️ Force Sync
                    </button>
                  )}
                  {!snapraidStatus.running && snapraidStatus.log && snapraidStatus.log.includes('--force-full') && (
                    <button 
                      onClick={() => handleSnapraidSync(true, true)}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-rose-600/20"
                    >
                      🔥 Force Full Rebuild
                    </button>
                  )}
                </div>
              </div>
              <div className="p-6 bg-slate-900/50">
                <div className="flex items-center justify-between mb-2">
                   <h4 className="text-sm font-medium text-slate-400 uppercase tracking-wider">SnapRAID Activity Log</h4>
                   {snapraidStatus.running && <span className="flex h-3 w-3 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span></span>}
                </div>
                <pre className="text-xs text-slate-400 bg-black/50 p-4 rounded-lg overflow-x-auto h-48 border border-slate-800 font-mono">
                  {snapraidStatus.log || "No log available."}
                </pre>
              </div>
            </div>

            {/* Disaster Recovery Modal */}
            {recoveryModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl p-6">
                  <h3 className="text-xl font-bold text-rose-400 mb-2">Disaster Recovery Wizard</h3>
                  <p className="text-sm text-slate-400 mb-6">Select the missing drive you want to rebuild, and choose an empty replacement drive to restore the data onto.</p>
                  
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Missing Drive</label>
                      <select 
                        value={selectedMissingDisk}
                        onChange={(e) => setSelectedMissingDisk(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none"
                      >
                        <option value="">-- Select Failed Drive --</option>
                        {missingDisks.map(d => (
                          <option key={d.name} value={d.name}>{d.name} (was {d.mountPoint})</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Replacement Target Drive</label>
                      <select 
                        value={selectedReplacementDisk}
                        onChange={(e) => setSelectedReplacementDisk(e.target.value)}
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg p-2.5 text-slate-200 focus:outline-none"
                      >
                        <option value="">-- Select New Unused Drive --</option>
                        {disks.filter(d => {
                          const isOS = d.children?.some(p => p.mountpoints?.includes('/'));
                          const isMounted = d.children?.some(p => p.mountpoints?.length > 0 && p.mountpoints[0] !== null);
                          return !isOS && !isMounted;
                        }).map(d => (
                          <option key={d.name} value={d.name}>{d.name} ({d.size})</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-8 flex justify-end gap-3">
                    <button 
                      onClick={() => setRecoveryModalOpen(false)}
                      className="px-4 py-2 text-slate-400 hover:text-white font-medium"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleRecover}
                      disabled={!selectedMissingDisk || !selectedReplacementDisk}
                      className="px-6 py-2 bg-rose-500 hover:bg-rose-600 disabled:bg-rose-500/50 disabled:cursor-not-allowed text-white rounded-lg font-bold transition-colors"
                    >
                      Start Rebuild
                    </button>
                  </div>
                </div>
              </div>
            )}

          </div>
        )}

        {/* Shares Tab */}
        {activeTab === 'shares' && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
             <div className="flex justify-between items-end">
              <div>
                <h2 className="text-2xl font-bold tracking-tight">Network Shares (Samba)</h2>
                <p className="text-slate-400 mt-1">Manage folders shared over the network to your Windows PC.</p>
              </div>
            </div>

            <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl overflow-hidden p-8 text-center">
                <div className="w-16 h-16 bg-indigo-500/10 text-indigo-400 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-4 border border-indigo-500/20">
                  📁
                </div>
                <h3 className="text-xl font-bold mb-2">SimpleNAS Main Pool</h3>
                <p className="text-slate-400 mb-6 max-w-md mx-auto">
                  This will expose your entire MergerFS storage pool to your local network.
                </p>

                <div className="max-w-xs mx-auto space-y-4 mb-6 text-left">
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Network Share Name</label>
                    <input 
                      type="text" 
                      value={shareName} 
                      onChange={(e) => setShareName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                      placeholder="e.g. SimpleNAS_Pool"
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                    <p className="text-[10px] text-slate-500 mt-1 italic">This is the folder name you will see on the network.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Network Username</label>
                    <input type="text" disabled value="simplenas" className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-slate-500 cursor-not-allowed" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-400 mb-1">Network Password</label>
                    <input 
                      type="password" 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter a secure password..."
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                    />
                  </div>
                </div>

                <div className="flex gap-4 justify-center">
                  <button 
                    onClick={async () => {
                      setLoading(true);
                      try {
                        const res = await fetch(`/api/shares/enable`, { 
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ shareName })
                        });
                        const data = await res.json();
                        if (data.success) {
                          alert(`Network Share Enabled! (Public Access)\n\nYou can now access \\\\${window.location.hostname}\\${shareName}`);
                        } else {
                          alert("Failed: " + data.error);
                        }
                      } catch(e) {
                        alert("Error enabling share.");
                      }
                      setLoading(false);
                    }}
                    className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-medium transition-all active:scale-95"
                  >
                    Enable (Public)
                  </button>
                  <button 
                    onClick={async () => {
                      if (!password || password.length < 4) {
                        alert("Please enter a password of at least 4 characters.");
                        return;
                      }
                      setLoading(true);
                      try {
                        const res = await fetch(`/api/shares/credentials`, { 
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ password, shareName })
                        });
                        const data = await res.json();
                        if (data.success) {
                          alert(data.message + `\n\nYou can now access \\\\${window.location.hostname}\\${shareName} using these credentials.`);
                        } else {
                          alert("Failed: " + data.error);
                        }
                      } catch(e) {
                        alert("Error setting security.");
                      }
                      setLoading(false);
                    }}
                    className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg font-medium shadow-lg shadow-indigo-500/20 transition-all active:scale-95 flex items-center gap-2"
                  >
                    🔒 Set Password & Enable
                  </button>
                </div>
                
                <div className="mt-8 pt-8 border-t border-slate-700/50 text-left bg-slate-900/50 -mx-8 -mb-8 p-8">
                  <h4 className="font-semibold text-slate-300 mb-2">How to connect from Windows:</h4>
                  <ol className="list-decimal pl-5 text-slate-400 space-y-2 text-sm">
                    <li>Open <strong>File Explorer</strong> (Win + E).</li>
                    <li>Click on the address bar at the very top.</li>
                    <li>Type <code className="bg-slate-800 px-2 py-0.5 rounded text-indigo-300">\\\\{window.location.hostname}\\{shareName}</code> and press Enter.</li>
                    <li>Right-click the folder and select "Map network drive" for easy access!</li>
                  </ol>
                </div>
            </div>
          </div>
        )}



      </main>
    </div>
  );
}

export default App;
