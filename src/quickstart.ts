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

/** Energy priority for ordering: higher-energy types go earlier in the day. */
const TYPE_ENERGY_PRIORITY: Record<BlockType, number> = {
  push: 0,
  flow: 1,
  steady: 2,
  growth: 3,
  drift: 4,
  rest: 5,
  buffer: 6,
};

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

/** Short duration for quick tasks. */
const QUICK_DURATION = 15;

/**
 * Match a free-text task to a block type.
 * Uses stem/prefix matching against BLOCK_TYPE_KEYWORDS, not just exact words.
 * Falls back to 'steady' if nothing matches.
 */
function inferBlockType(text: string): BlockType {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  // Exact word match first
  for (const word of words) {
    if (BLOCK_TYPE_KEYWORDS[word]) return BLOCK_TYPE_KEYWORDS[word];
  }

  // Stem/prefix match: "feeding" matches "feed", "cooking" matches "cook", etc.
  const keywords = Object.keys(BLOCK_TYPE_KEYWORDS);
  for (const word of words) {
    for (const kw of keywords) {
      if (word.startsWith(kw) || kw.startsWith(word)) {
        return BLOCK_TYPE_KEYWORDS[kw];
      }
    }
  }

  // Phrase-level match: check if the whole text contains a keyword
  for (const kw of keywords) {
    if (lower.includes(kw)) return BLOCK_TYPE_KEYWORDS[kw];
  }

  return 'steady';
}

/** Check if a task is a quick task (< 15 min). */
function isQuickTask(text: string): boolean {
  const lower = text.toLowerCase();
  return QUICK_TASK_PATTERNS.some(p => p.test(lower));
}

// ────────────────────────────────────────────────────────────
// Group & Schedule
// ────────────────────────────────────────────────────────────

interface ParsedTask {
  text: string;
  type: BlockType;
  quick: boolean;
}

interface PlannedBlock {
  title: string;
  menu: string[];
  type: BlockType;
  duration: number;
  start: string; // "HH:MM"
}

/**
 * Parse input into tasks, group by block type into blocks with menu items,
 * order by energy priority (push first, rest last), and spread across the day.
 */
function parseAndSchedule(input: string): PlannedBlock[] {
  const rawTasks = input
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (rawTasks.length === 0) return [];

  // Step 1: Classify each task
  const parsed: ParsedTask[] = rawTasks.map(text => ({
    text,
    type: inferBlockType(text),
    quick: isQuickTask(text),
  }));

  // Step 2: Group only drift/rest tasks (interchangeable chores/rest options).
  //         Everything else gets its own block — focused work isn't interchangeable.
  const groupedBlocks: PlannedBlock[] = [];
  const groupBuckets = new Map<BlockType, ParsedTask[]>();

  for (const task of parsed) {
    if (GROUPABLE_TYPES.has(task.type)) {
      if (!groupBuckets.has(task.type)) groupBuckets.set(task.type, []);
      groupBuckets.get(task.type)!.push(task);
    } else {
      // Individual block for this task
      groupedBlocks.push({
        title: task.text,
        menu: [task.text],
        type: task.type,
        duration: task.quick ? QUICK_DURATION : DEFAULT_DURATIONS[task.type],
        start: '',
      });
    }
  }

  // Create one block per groupable type with all tasks as menu options
  for (const [type, tasks] of groupBuckets) {
    const allQuick = tasks.every(t => t.quick);
    groupedBlocks.push({
      title: tasks.length === 1 ? tasks[0].text : TYPE_LABELS[type],
      menu: tasks.map(t => t.text),
      type,
      duration: allQuick ? QUICK_DURATION : DEFAULT_DURATIONS[type],
      start: '',
    });
  }

  // Step 3: Sort by energy priority (push first, rest last)
  groupedBlocks.sort(
    (a, b) => TYPE_ENERGY_PRIORITY[a.type] - TYPE_ENERGY_PRIORITY[b.type]
  );

  // Step 4: Assign start times from now, with buffers between blocks
  const now = new Date();
  let startMin = now.getHours() * 60 + now.getMinutes();
  startMin = Math.ceil(startMin / 30) * 30; // round up to next :00 or :30

  const endOfDay = 21 * 60;

  const scheduled: PlannedBlock[] = [];
  for (const block of groupedBlocks) {
    if (startMin + block.duration > endOfDay) break;

    const h = Math.floor(startMin / 60);
    const m = startMin % 60;
    block.start = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    scheduled.push(block);

    startMin += block.duration + 15; // 15-min buffer
  }

  return scheduled;
}

// ────────────────────────────────────────────────────────────
// UI
// ────────────────────────────────────────────────────────────

function fmtPreviewTime(start: string): string {
  const h = parseInt(start.split(':')[0]);
  const m = start.split(':')[1];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

function showQuickStart(): void {
  const overlay = document.createElement('div');
  overlay.className = 'quickstart-overlay';

  overlay.innerHTML = `
    <div class="quickstart-modal">
      <h3>What do you need to do today?</h3>
      <p class="quickstart-sub">List your tasks, separated by commas. The app will suggest block types and times based on energy levels — nothing is set in stone. You can edit, rearrange, or change any block after.</p>
      <textarea class="quickstart-input" rows="4" placeholder="e.g. gym, emails, work on thesis, cook dinner, feed the fish"></textarea>
      <div class="quickstart-preview" id="quickstartPreview"></div>
      <p class="quickstart-hint">This is just a starting point. Tap any block to edit the type, time, or tasks once it's on your timeline.</p>
      <div class="quickstart-actions">
        <button class="btn btn-primary quickstart-go" disabled>Build my day</button>
        <button class="btn btn-ghost quickstart-cancel">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const textarea = overlay.querySelector('.quickstart-input') as HTMLTextAreaElement;
  const preview = overlay.querySelector('#quickstartPreview') as HTMLElement;
  const goBtn = overlay.querySelector('.quickstart-go') as HTMLButtonElement;
  const cancelBtn = overlay.querySelector('.quickstart-cancel') as HTMLButtonElement;

  let planned: PlannedBlock[] = [];

  const updatePreview = (): void => {
    const value = textarea.value.trim();
    planned = parseAndSchedule(value);
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
        <span class="quickstart-preview-time">${fmtPreviewTime(b.start)} · ${b.duration}m</span>
      </div>`;
    }).join('');
  };

  textarea.addEventListener('input', updatePreview);

  goBtn.addEventListener('click', async () => {
    if (planned.length === 0) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Building...';

    const today = getTodayDate();

    for (const b of planned) {
      const block: FlowBlock = {
        type: b.type,
        title: b.title,
        menu: b.menu,
        start: b.start,
        duration: b.duration,
        days: [],
        date: today,
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
