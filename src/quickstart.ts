import { state } from './state.js';
import { BlockType, FlowBlock, BLOCK_TYPE_KEYWORDS, TYPE_LABELS, $id, esc, getTodayDate } from './utils.js';
import { renderTimeline } from './timeline.js';
import { renderWeek } from './week.js';

// ────────────────────────────────────────────────────────────
// Keyword → Block Type mapping (fuzzy, stem-aware)
// ────────────────────────────────────────────────────────────

/** Quick tasks that should get short durations (10-15 min). */
const QUICK_TASK_PATTERNS = [
  /\bfeed\b/, /\bwater\s+(the\s+)?plant/, /\btake\s+(my\s+)?med/,
  /\btake\s+vitamin/, /\btake\s+pill/, /\bcheck\s+mail/,
  /\btake\s+out\s+(the\s+)?trash/, /\bscoop\s+litter/, /\blet\s+(the\s+)?dog/,
  /\bpick\s+up/, /\bput\s+away/, /\btake\s+out\b/, /\bwipe\b/, /\bsweep\b/,
  /\bunload\b/, /\bload\s+(the\s+)?dishwasher/,
];

/** Block types where tasks are interchangeable "pick one" options (group into one block). */
const GROUPABLE_TYPES = new Set<BlockType>(['drift', 'rest']);

/** Default durations by block type (minutes). */
const DEFAULT_DURATIONS: Record<BlockType, number> = {
  push: 60,
  flow: 45,
  steady: 30,
  growth: 30,
  drift: 30,
  rest: 20,
  buffer: 15,
};

const QUICK_DURATION = 15;

function inferBlockType(text: string): BlockType {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  for (const word of words) {
    if (BLOCK_TYPE_KEYWORDS[word]) return BLOCK_TYPE_KEYWORDS[word];
  }

  const keywords = Object.keys(BLOCK_TYPE_KEYWORDS);
  for (const word of words) {
    for (const kw of keywords) {
      if (word.startsWith(kw) || kw.startsWith(word)) {
        return BLOCK_TYPE_KEYWORDS[kw];
      }
    }
  }

  for (const kw of keywords) {
    if (lower.includes(kw)) return BLOCK_TYPE_KEYWORDS[kw];
  }

  return 'steady';
}

function isQuickTask(text: string): boolean {
  const lower = text.toLowerCase();
  return QUICK_TASK_PATTERNS.some(p => p.test(lower));
}

// ────────────────────────────────────────────────────────────
// Group (no scheduling — everything goes to pool)
// ────────────────────────────────────────────────────────────

interface ParsedTask {
  text: string;
  type: BlockType;
  quick: boolean;
}

interface PoolItem {
  title: string;
  menu: string[];
  type: BlockType;
  duration: number;
}

function parseIntoPooItems(input: string): PoolItem[] {
  const rawTasks = input
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (rawTasks.length === 0) return [];

  const parsed: ParsedTask[] = rawTasks.map(text => ({
    text,
    type: inferBlockType(text),
    quick: isQuickTask(text),
  }));

  const items: PoolItem[] = [];
  const groupBuckets = new Map<BlockType, ParsedTask[]>();

  for (const task of parsed) {
    if (GROUPABLE_TYPES.has(task.type)) {
      if (!groupBuckets.has(task.type)) groupBuckets.set(task.type, []);
      groupBuckets.get(task.type)!.push(task);
    } else {
      items.push({
        title: task.text,
        menu: [task.text],
        type: task.type,
        duration: task.quick ? QUICK_DURATION : DEFAULT_DURATIONS[task.type],
      });
    }
  }

  for (const [type, tasks] of groupBuckets) {
    const allQuick = tasks.every(t => t.quick);
    items.push({
      title: tasks.length === 1 ? tasks[0].text : TYPE_LABELS[type],
      menu: tasks.map(t => t.text),
      type,
      duration: allQuick ? QUICK_DURATION : DEFAULT_DURATIONS[type],
    });
  }

  return items;
}

// ────────────────────────────────────────────────────────────
// UI
// ────────────────────────────────────────────────────────────

function showQuickStart(): void {
  const overlay = document.createElement('div');
  overlay.className = 'quickstart-overlay';

  overlay.innerHTML = `
    <div class="quickstart-modal">
      <h3>What's floating around in your head?</h3>
      <p class="quickstart-sub">Get it all out — separate with commas or new lines. Nothing gets scheduled, it all goes into your pool. You decide what to do when you're ready.</p>
      <textarea class="quickstart-input" rows="4" placeholder="e.g. gym, emails, work on thesis, cook dinner, feed the fish"></textarea>
      <div class="quickstart-preview" id="quickstartPreview"></div>
      <p class="quickstart-hint">Everything lands in your pool as options. Pick from them whenever the energy fits.</p>
      <div class="quickstart-actions">
        <button class="btn btn-primary quickstart-go" disabled>Add to pool</button>
        <button class="btn btn-ghost quickstart-cancel">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const textarea = overlay.querySelector('.quickstart-input') as HTMLTextAreaElement;
  const preview = overlay.querySelector('#quickstartPreview') as HTMLElement;
  const goBtn = overlay.querySelector('.quickstart-go') as HTMLButtonElement;
  const cancelBtn = overlay.querySelector('.quickstart-cancel') as HTMLButtonElement;

  let planned: PoolItem[] = [];

  const updatePreview = (): void => {
    const value = textarea.value.trim();
    planned = parseIntoPooItems(value);
    goBtn.disabled = planned.length === 0;

    if (planned.length === 0) {
      preview.innerHTML = '';
      return;
    }

    preview.innerHTML = planned.map(b => {
      const menuStr = b.menu.length > 1
        ? `<span class="quickstart-preview-menu">${b.menu.map(m => esc(m)).join(' · ')}</span>`
        : '';
      return `<div class="quickstart-preview-item">
        <span class="quickstart-preview-type type-badge-${b.type}">${esc(TYPE_LABELS[b.type])}</span>
        <div class="quickstart-preview-info">
          <span class="quickstart-preview-text">${esc(b.title)}</span>
          ${menuStr}
        </div>
        <span class="quickstart-preview-time">~${b.duration}m</span>
      </div>`;
    }).join('');
  };

  textarea.addEventListener('input', updatePreview);

  goBtn.addEventListener('click', async () => {
    if (planned.length === 0) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Adding...';

    for (const b of planned) {
      const block: FlowBlock = {
        type: b.type,
        title: b.title,
        menu: b.menu,
        start: '',       // no time = pool item
        duration: b.duration,
        days: [],
        date: null,      // persistent — stays until completed or removed
        status: 'pending',
      };
      await state.addBlock(block, 'modal');
    }

    overlay.remove();
    renderTimeline();
    renderWeek();
  });

  cancelBtn.addEventListener('click', () => overlay.remove());

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  setTimeout(() => textarea.focus(), 100);
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export function initQuickStart(): void {
  const btn = $id('quickStartBtn');
  if (btn) btn.addEventListener('click', showQuickStart);
}
