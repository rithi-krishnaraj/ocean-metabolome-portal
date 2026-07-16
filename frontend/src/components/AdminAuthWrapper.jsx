import { useState } from 'react';
import AdminPage from '../pages/AdminPage';
import { Lock, HelpCircle, CheckCircle, ArrowLeft } from 'lucide-react'; // Added HelpCircle, CheckCircle, ArrowLeft

const SECURITY_QUESTIONS = [
  {
    question: "What was your first pet's name?",
    answer: "buddy",
  },
  {
    question: "What is your mother's maiden name?",
    answer: "smith",
  },
  {
    question: "What city were you born in?",
    answer: "newyork",
  },
  {
    question: "What is your favorite book?",
    answer: "thehobbit",
  },
  {
    question: "What is the name of your elementary school?",
    answer: "oakhill",
  },
];

export default function AdminAuthWrapper() {
  const [password, setPassword] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState('');

  // Password Reset States
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [securityAnswerInput, setSecurityAnswerInput] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSuccess, setResetSuccess] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // IMPORTANT: In a real application, this password should NOT be hardcoded
  // and should be securely fetched from an environment variable or a backend service.
  // For the purpose of this example, we'll store the "reset" password in localStorage for persistence
  const getCorrectPassword = () => {
    return localStorage.getItem('adminPassword') || 'adminpassword';
  };

  const setAdminPassword = (newP) => {
    localStorage.setItem('adminPassword', newP);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (password === getCorrectPassword()) {
      setIsAuthenticated(true);
      setError('');
    } else {
      setError('Incorrect password. Please try again.');
      setPassword('');
    }
  };

  const handleSecurityAnswerSubmit = (e) => {
    e.preventDefault();
    setResetError('');

    if (securityAnswerInput.toLowerCase() === SECURITY_QUESTIONS[currentQuestionIndex].answer) {
      if (currentQuestionIndex < SECURITY_QUESTIONS.length - 1) {
        setCurrentQuestionIndex(currentQuestionIndex + 1);
        setSecurityAnswerInput('');
      } else {
        // All questions answered correctly
        setResetSuccess(true);
        setSecurityAnswerInput('');
      }
    } else {
      setResetError('Incorrect answer. Please try again.');
      setSecurityAnswerInput('');
    }
  };

  const handlePasswordReset = (e) => {
    e.preventDefault();
    setResetError('');

    if (newPassword !== confirmNewPassword) {
      setResetError('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < 6) { // Basic validation
      setResetError('Password must be at least 6 characters long.');
      return;
    }

    setAdminPassword(newPassword);
    setResetSuccess(false); // Hide the set new password form
    setShowForgotPassword(false); // Go back to login form
    setIsAuthenticated(false); // Force re-authentication with new password
    setPassword(''); // Clear old password
    setNewPassword('');
    setConfirmNewPassword('');
    setError('Password has been reset successfully. Please log in with your new password.');
  };

  if (isAuthenticated) {
    return <AdminPage />;
  }

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-60px)] bg-slate-900">
      <div className="bg-slate-800 p-8 rounded-lg shadow-xl border border-slate-700 w-full max-w-sm">
        {!showForgotPassword ? (
          <>
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
                className="w-full bg-ocean-600 hover:bg-ocean-700 text-white font-semibold py-2 px-4 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:ring-offset-2 focus:ring-offset-slate-800"
              >
                Unlock
              </button>
            </form>
            <button
              onClick={() => {
                setShowForgotPassword(true);
                setError(''); // Clear login error when going to forgot password
              }}
              className="mt-4 w-full text-center text-sm text-slate-400 hover:text-ocean-400 transition-colors flex items-center justify-center gap-1"
            >
              <HelpCircle size={14} /> Forgot Password?
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center mb-6">
              <button
                onClick={() => {
                  setShowForgotPassword(false);
                  setCurrentQuestionIndex(0);
                  setResetError('');
                  setResetSuccess(false);
                  setSecurityAnswerInput('');
                }}
                className="text-slate-400 hover:text-slate-200 transition-colors mr-2"
                title="Back to login"
              >
                <ArrowLeft size={20} />
              </button>
              <div className="flex flex-col items-center flex-1">
                <HelpCircle size={32} className="text-ocean-400 mb-3" />
                <h2 className="text-2xl font-bold text-white mb-2">Password Reset</h2>
                <p className="text-slate-400 text-sm text-center">Answer security questions to reset your password.</p>
              </div>
            </div>

            {!resetSuccess ? (
              <form onSubmit={handleSecurityAnswerSubmit} className="space-y-4">
                <div>
                  <label htmlFor="security-question" className="block text-sm font-medium text-slate-300 mb-2">
                    Question {currentQuestionIndex + 1} of {SECURITY_QUESTIONS.length}:
                  </label>
                  <p className="text-white mb-3">{SECURITY_QUESTIONS[currentQuestionIndex].question}</p>
                  <input
                    type="text"
                    id="security-question"
                    className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:border-transparent"
                    placeholder="Your answer"
                    value={securityAnswerInput}
                    onChange={(e) => setSecurityAnswerInput(e.target.value)}
                    required
                  />
                </div>
                {resetError && <p className="text-red-400 text-sm text-center">{resetError}</p>}
                <button
                  type="submit"
                  className="w-full bg-ocean-600 hover:bg-ocean-700 text-white font-semibold py-2 px-4 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:ring-offset-2 focus:ring-offset-slate-800"
                >
                  {currentQuestionIndex < SECURITY_QUESTIONS.length - 1 ? 'Next Question' : 'Verify Answers'}
                </button>
              </form>
            ) : (
              <form onSubmit={handlePasswordReset} className="space-y-4">
                <div className="text-green-400 text-center flex items-center justify-center gap-2 mb-4">
                  <CheckCircle size={18} />
                  <p>All security questions answered correctly!</p>
                </div>
                <div>
                  <label htmlFor="new-password" className="sr-only">New Password</label>
                  <input
                    type="password"
                    id="new-password"
                    className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:border-transparent"
                    placeholder="Enter new password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label htmlFor="confirm-new-password" className="sr-only">Confirm New Password</label>
                  <input
                    type="password"
                    id="confirm-new-password"
                    className="w-full px-4 py-2 bg-slate-700 border border-slate-600 rounded-md text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:border-transparent"
                    placeholder="Confirm new password"
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    required
                  />
                </div>
                {resetError && <p className="text-red-400 text-sm text-center">{resetError}</p>}
                <button
                  type="submit"
                  className="w-full bg-ocean-600 hover:bg-ocean-700 text-white font-semibold py-2 px-4 rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-ocean-500 focus:ring-offset-2 focus:ring-offset-slate-800"
                >
                  Set New Password
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}