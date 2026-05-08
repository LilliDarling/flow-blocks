import { supabase } from './supabase.js';
import { $id } from './utils.js';
import { clearEventQueue } from './events.js';
import { unsubscribeFromPush } from './push.js';
import { isNative } from './native.js';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';

const NATIVE_OAUTH_REDIRECT = 'wildbloom://auth/callback';

type AuthCallback = (userId: string | null) => void;

let onAuthChange: AuthCallback = () => {};
let lastNotifiedUserId: string | null | undefined = undefined;

export function onAuth(callback: AuthCallback): void {
  onAuthChange = callback;
}

// Dedupes repeated notifications for the same user — getSession() and
// onAuthStateChange both fire on load, and onAuthStateChange also fires on
// TOKEN_REFRESHED, which would otherwise re-trigger the sign-in flow.
function notifyAuth(userId: string | null): void {
  if (lastNotifiedUserId === userId) return;
  lastNotifiedUserId = userId;
  onAuthChange(userId);
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

  // After a successful account deletion the app reloads to /?deleted=1 — show
  // a confirmation in the auth feedback area, then clean the URL so a refresh
  // doesn't keep the message around.
  const params = new URLSearchParams(window.location.search);
  if (params.get('deleted') === '1') {
    showSuccess('Your account has been deleted.');
    const url = new URL(window.location.href);
    url.searchParams.delete('deleted');
    history.replaceState({}, '', url.pathname + (url.search || ''));
  }
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
  el.style.color = 'var(--growth)';
  (el as HTMLElement).style.background = 'var(--accent-glow)';
  (el as HTMLElement).style.borderLeft = '3px solid var(--growth)';
}

function clearError(): void {
  const el = $id('authError');
  el.textContent = '';
  el.style.display = 'none';
}

// --- Password toggle ---

function initPasswordToggle(): void {
  wirePasswordToggle('authPasswordToggle', 'authPassword');
}

function initPasswordRecoveryToggle(): void {
  wirePasswordToggle('passwordRecoveryToggle', 'passwordRecoveryInput');
}

function wirePasswordToggle(toggleId: string, inputId: string): void {
  const toggle = $id(toggleId);
  const input = $id(inputId) as HTMLInputElement;
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
    redirectTo: isNative ? NATIVE_OAUTH_REDIRECT : `${window.location.origin}/`,
  });

  if (error) {
    showError(error.message);
  } else {
    showSuccess('Password reset link sent — check your email.');
  }
}

async function handleGoogleSignIn(): Promise<void> {
  clearError();

  if (isNative) {
    // Native: get the OAuth URL from Supabase, then open it in an in-app browser.
    // Supabase will redirect back to `wildbloom://auth/callback` which the
    // appUrlOpen listener in native.ts captures to set the session.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: NATIVE_OAUTH_REDIRECT,
        skipBrowserRedirect: true,
      },
    });
    if (error) { showError(error.message); return; }
    if (!data?.url) { showError('Could not start Google sign-in.'); return; }

    const { Browser } = await import('@capacitor/browser');
    await Browser.open({ url: data.url, presentationStyle: 'popover' });
    return;
  }

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

async function handleMagicLink(): Promise<void> {
  clearError();
  const email = ($id('authEmail') as HTMLInputElement).value.trim();

  if (!email) {
    showError('Enter your email address first.');
    return;
  }

  // shouldCreateUser: false avoids silently creating an account if the user
  // typoed their email — magic link is for existing accounts only.
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: isNative ? NATIVE_OAUTH_REDIRECT : `${window.location.origin}/`,
    },
  });

  if (error) {
    showError(error.message);
  } else {
    showSuccess('Sign-in link sent — check your email.');
  }
}

// --- Password recovery (post-reset-email click) ---

function showPasswordRecoveryModal(): void {
  const modal = $id('passwordRecoveryModal');
  modal.classList.add('open');
  const input = $id('passwordRecoveryInput') as HTMLInputElement;
  input.value = '';
  const err = $id('passwordRecoveryError');
  err.textContent = '';
  err.style.display = 'none';
  setTimeout(() => input.focus(), 50);
}

function hidePasswordRecoveryModal(): void {
  $id('passwordRecoveryModal').classList.remove('open');
}

async function handlePasswordRecoverySave(): Promise<void> {
  const input = $id('passwordRecoveryInput') as HTMLInputElement;
  const err = $id('passwordRecoveryError');
  const password = input.value;

  if (!password || password.length < 6) {
    err.textContent = 'Password must be at least 6 characters.';
    err.style.display = 'block';
    return;
  }

  const saveBtn = $id('passwordRecoverySave') as HTMLButtonElement;
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.auth.updateUser({ password });

  saveBtn.disabled = false;
  saveBtn.textContent = 'Save password';

  if (error) {
    err.textContent = error.message;
    err.style.display = 'block';
    return;
  }

  hidePasswordRecoveryModal();
}

async function handleResendConfirmation(): Promise<void> {
  clearError();
  const email = ($id('authEmail') as HTMLInputElement).value.trim();

  if (!email) {
    showError('Enter the email you signed up with first.');
    return;
  }

  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: {
      emailRedirectTo: isNative ? NATIVE_OAUTH_REDIRECT : `${window.location.origin}/`,
    },
  });

  if (error) {
    showError(error.message);
  } else {
    showSuccess('Confirmation email sent — check your inbox.');
  }
}

// --- Profile modal ---

function showProfileModal(): void {
  const modal = $id('profileModal');
  const emailEl = $id('profileEmail');
  const feedback = $id('profileFeedback');

  feedback.textContent = '';
  feedback.style.display = 'none';

  supabase.auth.getUser().then(({ data: { user } }) => {
    emailEl.textContent = user?.email ?? '—';
  });

  modal.classList.add('open');
}

function hideProfileModal(): void {
  $id('profileModal').classList.remove('open');
}

function showProfileFeedback(msg: string, kind: 'success' | 'error'): void {
  const el = $id('profileFeedback');
  el.textContent = msg;
  el.style.display = 'block';
  el.dataset.kind = kind;
}

async function handleProfileResetPassword(): Promise<void> {
  const btn = $id('profileResetBtn') as HTMLButtonElement;
  const { data: { user } } = await supabase.auth.getUser();
  const email = user?.email;

  if (!email) {
    showProfileFeedback("We couldn't find an email on your account.", 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: isNative ? NATIVE_OAUTH_REDIRECT : `${window.location.origin}/`,
  });

  btn.disabled = false;
  btn.textContent = 'Send reset link';

  if (error) {
    showProfileFeedback(error.message, 'error');
  } else {
    showProfileFeedback(`Reset link sent to ${email}. Check your inbox.`, 'success');
  }
}

/** Wipe everything tied to the current user: server-side push registration,
 *  any OS-scheduled notifications, the IDB event queue, per-user
 *  localStorage, and sessionStorage. Used by both sign-out and account
 *  deletion. Must run while the JWT is still valid — RLS rejects
 *  push-subscription DELETEs once the session is gone. */
async function clearLocalUserData(userId: string | null): Promise<void> {
  if (userId) {
    await unsubscribeFromPush(userId);
  }

  // Native-only: WebView reload doesn't touch native plugin state. Without
  // this, OS-scheduled notifications from the previous user's session can
  // fire for whoever signs in next, leaking task names and reminder content.
  if (isNative) {
    try {
      const { LocalNotifications } = await import('@capacitor/local-notifications');
      const { notifications } = await LocalNotifications.getPending();
      if (notifications.length > 0) {
        await LocalNotifications.cancel({ notifications });
      }
    } catch (err) {
      console.warn('[cleanup] LocalNotifications cleanup failed:', err);
    }

    try {
      const { Browser } = await import('@capacitor/browser');
      await Browser.close();
    } catch {
      /* not open / plugin missing */
    }
  }

  await clearEventQueue();
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k && k.startsWith('hidden_cal_')) localStorage.removeItem(k);
  }
  sessionStorage.clear();
}

async function handleSignOut(): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  await clearLocalUserData(user?.id ?? null);

  await supabase.auth.signOut();

  // Hard reload kills in-memory state and pending reminder setTimeouts.
  window.location.reload();
}

// --- Account deletion ---

function showDeleteConfirm(email: string): void {
  $id('profileDeleteIntro').style.display = 'none';
  $id('profileDeleteEmailHint').textContent = email;
  $id('profileDeleteConfirm').style.display = 'block';
  const input = $id('profileDeleteConfirmInput') as HTMLInputElement;
  input.value = '';
  (input as HTMLInputElement).disabled = false;
  ($id('profileDeleteFinalBtn') as HTMLButtonElement).disabled = true;
  setTimeout(() => input.focus(), 50);
}

function hideDeleteConfirm(): void {
  $id('profileDeleteConfirm').style.display = 'none';
  $id('profileDeleteIntro').style.display = '';
  ($id('profileDeleteConfirmInput') as HTMLInputElement).value = '';
}

function updateDeleteFinalEnabled(): void {
  const input = $id('profileDeleteConfirmInput') as HTMLInputElement;
  const expected = ($id('profileDeleteEmailHint').textContent || '').trim().toLowerCase();
  const typed = input.value.trim().toLowerCase();
  ($id('profileDeleteFinalBtn') as HTMLButtonElement).disabled = !expected || typed !== expected;
}

async function handleDeleteAccount(): Promise<void> {
  const finalBtn = $id('profileDeleteFinalBtn') as HTMLButtonElement;
  const cancelBtn = $id('profileDeleteCancelBtn') as HTMLButtonElement;
  const input = $id('profileDeleteConfirmInput') as HTMLInputElement;

  // Capture user before deletion — we need user.id for cleanup AND we need
  // the JWT to still be valid when the Edge Function reads auth.uid().
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    showProfileFeedback('You appear to be signed out. Refresh and try again.', 'error');
    return;
  }

  finalBtn.disabled = true;
  finalBtn.textContent = 'Deleting…';
  cancelBtn.disabled = true;
  input.disabled = true;

  // Edge Function runs first — it explicitly deletes from every user-data
  // table and then calls auth.admin.deleteUser. If it fails, we leave the
  // user signed in with their data intact so they can retry.
  const { data, error } = await supabase.functions.invoke('delete-account', {
    method: 'POST',
  });

  const ok = !error && (data as { ok?: boolean })?.ok === true;
  if (!ok) {
    console.error('[delete-account] failed:', error || data);
    showProfileFeedback(
      'We couldn\'t delete your account just now. Please try again, or email lillith@valkyrieremedy.com if it keeps failing.',
      'error',
    );
    finalBtn.disabled = false;
    finalBtn.textContent = 'Permanently delete';
    cancelBtn.disabled = false;
    input.disabled = false;
    return;
  }

  // Server is clean. Wipe the same client-side state that sign-out clears.
  // The JWT we used above is now invalid — push DELETEs will hit zero rows
  // (the Edge Function already cascade-cleared them) but the browser-side
  // unsubscribe + listener cleanup still need to run.
  await clearLocalUserData(user.id);
  await supabase.auth.signOut();

  // Replace (don't push) so the back button doesn't return to the deleted-
  // account view. ?deleted=1 triggers the confirmation message in showAuth.
  window.location.replace(window.location.pathname + '?deleted=1');
}

// --- Init ---

export function initAuth(): void {
  // Wire up auth form buttons
  $id('authSignIn').addEventListener('click', handleSignIn);
  $id('authSignUp').addEventListener('click', handleSignUp);
  $id('authGoogle').addEventListener('click', handleGoogleSignIn);
  $id('authMagic').addEventListener('click', handleMagicLink);
  $id('authForgot').addEventListener('click', handleForgotPassword);
  $id('authResend').addEventListener('click', handleResendConfirmation);
  $id('signOutBtn').addEventListener('click', handleSignOut);

  // Profile modal wiring
  $id('profileBtn').addEventListener('click', showProfileModal);
  $id('profileCloseBtn').addEventListener('click', hideProfileModal);
  $id('profileResetBtn').addEventListener('click', handleProfileResetPassword);
  $id('profileModal').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'profileModal') hideProfileModal();
  });

  // Account deletion: button → confirm step → final destructive action
  $id('profileDeleteBtn').addEventListener('click', async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.email) showDeleteConfirm(user.email);
  });
  $id('profileDeleteCancelBtn').addEventListener('click', hideDeleteConfirm);
  $id('profileDeleteConfirmInput').addEventListener('input', updateDeleteFinalEnabled);
  $id('profileDeleteConfirmInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter'
        && !($id('profileDeleteFinalBtn') as HTMLButtonElement).disabled) {
      handleDeleteAccount();
    }
  });
  $id('profileDeleteFinalBtn').addEventListener('click', handleDeleteAccount);

  // Password recovery modal wiring
  $id('passwordRecoverySave').addEventListener('click', handlePasswordRecoverySave);
  $id('passwordRecoveryCancel').addEventListener('click', hidePasswordRecoveryModal);
  $id('passwordRecoveryInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handlePasswordRecoverySave();
  });
  initPasswordRecoveryToggle();

  // Password visibility toggle
  initPasswordToggle();

  // Allow Enter key to submit
  $id('authPassword').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') handleSignIn();
  });

  // Listen for auth state changes (fires after initial check too)
  supabase.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
    if (event === 'PASSWORD_RECOVERY') {
      // Recovery link click — they're signed in via a recovery session, prompt
      // for a new password before they go further. Skipping is allowed; the
      // old password keeps working until they choose a new one.
      showPasswordRecoveryModal();
    }
    if (session?.user) {
      // Don't call showApp() here — let onUserSignedIn do it after data loads.
      // But if auth changes AFTER initial load (e.g. sign-in from auth screen),
      // we still need to notify the callback.
      notifyAuth(session.user.id);
    } else {
      showAuth();
      notifyAuth(null);
    }
  });

  // Check initial session — the splash screen stays visible until this resolves
  supabase.auth.getSession().then(({ data: { session } }) => {
    if (session?.user) {
      // Don't showApp yet — onUserSignedIn will call showApp after data loads
      notifyAuth(session.user.id);
    } else {
      showAuth();
    }
  });
}
