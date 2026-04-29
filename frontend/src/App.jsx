import { useState, useEffect } from 'react';

function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [disks, setDisks] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeTab === 'storage') {
      fetchDisks();
    }
  }, [activeTab]);

  const fetchDisks = async () => {
    setLoading(true);
    try {
      // The backend runs on port 3001
      const res = await fetch(`http://${window.location.hostname}:3001/api/disks`);
      const data = await res.json();
      if (data.success) {
        setDisks(data.disks);
      }
    } catch (error) {
      console.error("Failed to fetch disks", error);
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
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Pool Status</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-emerald-400">Online</span>
                </div>
                <p className="text-sm text-slate-500 mt-2">MergerFS pool is healthy.</p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Data Protection</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-amber-400">Unconfigured</span>
                </div>
                <p className="text-sm text-slate-500 mt-2">SnapRAID is not set up yet.</p>
              </div>
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 backdrop-blur-sm">
                <h3 className="text-sm font-medium text-slate-400 uppercase tracking-wider">Storage Capacity</h3>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-bold text-slate-200">0 GB</span>
                  <span className="text-sm font-medium text-slate-500">/ 0 GB</span>
                </div>
                <div className="w-full bg-slate-700/50 rounded-full h-2 mt-4 overflow-hidden">
                  <div className="bg-gradient-to-r from-indigo-500 to-purple-500 h-2 rounded-full w-0"></div>
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
                    
                    return (
                      <div key={disk.name} className="p-6 flex items-center justify-between hover:bg-slate-800/80 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-xl shadow-inner ${isOS ? 'bg-slate-800 text-slate-500 border border-slate-700' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'}`}>
                            🖴
                          </div>
                          <div>
                            <h3 className="font-semibold text-lg flex items-center gap-2">
                              {disk.name}
                              {isOS && <span className="text-[10px] uppercase tracking-wider bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">OS Drive</span>}
                            </h3>
                            <p className="text-sm text-slate-400 flex gap-3">
                              <span>{disk.size}</span>
                              <span>•</span>
                              <span>{disk.model || 'Unknown Model'}</span>
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          {isOS ? (
                            <button disabled className="px-4 py-2 bg-slate-800/50 text-slate-500 rounded-lg text-sm font-medium cursor-not-allowed">
                              System Drive (Locked)
                            </button>
                          ) : (
                            <>
                              <button className="px-4 py-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded-lg text-sm font-medium transition-colors">
                                Add to Data Pool
                              </button>
                              <button className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors">
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
          </div>
        )}

      </main>
    </div>
  );
}

export default App;
