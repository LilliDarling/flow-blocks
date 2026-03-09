import { supabase } from './supabase.js';
import { $id } from './utils.js';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

type AuthCallback = (userId: string | null) => void;

let onAuthChange: AuthCallback = () => {};

export function onAuth(callback: AuthCallback): void {
  onAuthChange = callback;
}

function showAuth(): void {
  $id('authScreen').style.display = 'flex';
  $id('appScreen').style.display = 'none';
}

function showApp(): void {
  $id('authScreen').style.display = 'none';
  $id('appScreen').style.display = 'block';
}

function showError(msg: string): void {
  const el = $id('authError');
  el.textContent = msg;
  el.style.display = 'block';
}

function clearError(): void {
  const el = $id('authError');
  el.textContent = '';
  el.style.display = 'none';
}

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
    showError(''); // clear
    $id('authError').style.display = 'block';
    $id('authError').textContent = 'Check your email for a confirmation link!';
    $id('authError').style.color = 'var(--recharge)';
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
}

async function handleSignOut(): Promise<void> {
  await supabase.auth.signOut();
}

export function initAuth(): void {
  // Wire up auth form buttons
  $id('authSignIn').addEventListener('click', handleSignIn);
  $id('authSignUp').addEventListener('click', handleSignUp);
  $id('signOutBtn').addEventListener('click', handleSignOut);

  // Allow Enter key to submit
  $id('authPassword').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSignIn();
  });

  // Listen for auth state changes
  supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => {
    if (session?.user) {
      showApp();
      onAuthChange(session.user.id);
    } else {
      showAuth();
      onAuthChange(null);
    }
  });

  // Check initial session
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.user) {
      showApp();
      onAuthChange(session.user.id);
    } else {
      showAuth();
    }
  });
}
