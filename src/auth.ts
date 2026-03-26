import { supabase } from './supabase.js';
import { $id } from './utils.js';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthCallback = (userId: string | null) => void;

let onAuthChange: AuthCallback = () => {};
let initialResolved = false;

export function onAuth(callback: AuthCallback): void {
  onAuthChange = callback;
}

function hideSplash(): void {
  const splash = document.getElementById('splashScreen');
  if (!splash) return;
  splash.classList.add('splash-fade');
  setTimeout(() => { splash.style.display = 'none'; }, 300);
}

export function showAuth(): void {
  hideSplash();
  $id('authScreen').style.display = 'flex';
  $id('appScreen').style.display = 'none';
}

/** Call this after data is loaded to reveal the app screen. */
export function showApp(): void {
  hideSplash();
  $id('authScreen').style.display = 'none';
  $id('appScreen').style.display = 'block';
}

function showError(msg: string): void {
  const el = $id('authError');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.color = 'var(--danger)';
  (el as HTMLElement).style.background = 'var(--accent-glow)';
  (el as HTMLElement).style.borderLeft = '3px solid var(--danger)';
}

function showSuccess(msg: string): void {
  const el = $id('authError');
  el.textContent = msg;
  el.style.display = 'block';
  el.style.color = 'var(--recharge)';
  (el as HTMLElement).style.background = 'var(--accent-glow)';
  (el as HTMLElement).style.borderLeft = '3px solid var(--recharge)';
}

function clearError(): void {
  const el = $id('authError');
  el.textContent = '';
  el.style.display = 'none';
}

// --- Password toggle ---

function initPasswordToggle(): void {
  const toggle = $id('authPasswordToggle');
  const input = $id('authPassword') as HTMLInputElement;
  const eyeIcon = toggle.querySelector('.eye-icon') as SVGElement;
  const eyeOffIcon = toggle.querySelector('.eye-off-icon') as SVGElement;

  toggle.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    eyeIcon.style.display = isPassword ? 'none' : '';
    eyeOffIcon.style.display = isPassword ? '' : 'none';
  });
}

// --- Auth actions ---

async function handleSignUp(): Promise<void> {
  clearError();
  const email = ($id('authEmail') as HTMLInputElement).value.trim();
  const password = ($id('authPassword') as HTMLInputElement).value;

  if (!email || !password) {
    showError('Email and password are required.');
    return;
  }
  if (password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    showError(error.message);
  } else {
    showSuccess('Check your email for a confirmation link!');
  }
}

async function handleSignIn(): Promise<void> {
  clearError();
  const email = ($id('authEmail') as HTMLInputElement).value.trim();
  const password = ($id('authPassword') as HTMLInputElement).value;

  if (!email || !password) {
    showError('Email and password are required.');
    return;
  }

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    showError(error.message);
  }
  // On success, onAuthStateChange will fire and the callback handles the rest
}

async function handleForgotPassword(): Promise<void> {
  clearError();
  const email = ($id('authEmail') as HTMLInputElement).value.trim();

  if (!email) {
    showError('Enter your email address first, then click "Forgot password?"');
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/`,
  });

  if (error) {
    showError(error.message);
  } else {
    showSuccess('Password reset link sent — check your email.');
  }
}

async function handleGoogleSignIn(): Promise<void> {
  clearError();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin,
    },
  });
  if (error) {
    showError(error.message);
  }
}

async function handleSignOut(): Promise<void> {
  await supabase.auth.signOut();
}

// --- Init ---

export function initAuth(): void {
  // Wire up auth form buttons
  $id('authSignIn').addEventListener('click', handleSignIn);
  $id('authSignUp').addEventListener('click', handleSignUp);
  $id('authGoogle').addEventListener('click', handleGoogleSignIn);
  $id('authForgot').addEventListener('click', handleForgotPassword);
  $id('signOutBtn').addEventListener('click', handleSignOut);

  // Password visibility toggle
  initPasswordToggle();

  // Allow Enter key to submit
  $id('authPassword').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSignIn();
  });

  // Listen for auth state changes (fires after initial check too)
  supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
    if (session?.user) {
      // Don't call showApp() here — let onUserSignedIn do it after data loads.
      // But if auth changes AFTER initial load (e.g. sign-in from auth screen),
      // we still need to notify the callback.
      onAuthChange(session.user.id);
    } else {
      showAuth();
      onAuthChange(null);
    }
  });

  // Check initial session — the splash screen stays visible until this resolves
  supabase.auth.getSession().then(({ data: { session } }) => {
    initialResolved = true;
    if (session?.user) {
      // Don't showApp yet — onUserSignedIn will call showApp after data loads
      onAuthChange(session.user.id);
    } else {
      showAuth();
    }
  });
}
