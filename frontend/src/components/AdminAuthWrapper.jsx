import { useEffect, useState } from 'react';
import AdminPage from '../pages/AdminPage';
import { Lock } from 'lucide-react';
import { adminLogin, getAdminToken } from '../api';

// The password is checked by the backend, which also refuses uploads, saves and
// deletes without the token it issues. To change the password, edit ADMIN_PASSWORD
// in the server's .env and restart the backend.
export default function AdminAuthWrapper() {
  const [password, setPassword] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getAdminToken());
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => {
      setIsAuthenticated(false);
      setError('Your admin session has expired. Please log in again.');
    };
    window.addEventListener('admin-unauthorized', onUnauthorized);
    return () => window.removeEventListener('admin-unauthorized', onUnauthorized);
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await adminLogin(password);
      setIsAuthenticated(true);
      setError('');
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setPassword('');
      setSubmitting(false);
    }
  };

  if (isAuthenticated) {
    return <AdminPage />;
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-60px)] bg-slate-900">
      <div className="bg-slate-800 p-8 rounded-lg shadow-xl border border-slate-700 w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <Lock size={32} className="text-ocean-400 mb-3" />
          <h2 className="text-2xl font-bold text-white mb-2">Admin Access</h2>
          <p className="text-slate-400 text-sm text-center">Enter password to access the Admin Panel.</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <input
              type="password"
              id="password"
              className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:border-transparent"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="text-red-400 text-sm text-center">{error}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-ocean-600 hover:bg-ocean-700 text-white font-semibold py-2 px-4 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:ring-offset-2 focus:ring-offset-slate-800 disabled:opacity-50"
          >
            {submitting ? 'Checking…' : 'Unlock'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-500">
          Forgot the password? Ask the server administrator to reset ADMIN_PASSWORD.
        </p>
      </div>
    </div>
  );
}
