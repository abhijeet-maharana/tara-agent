import { formatDuration } from '../slack/format.js';
import type { StoredRun } from '../store/store.js';

/** A job's scheduled slots in the digest window that nobody claimed (tara-agent was down, say). */
export interface MissedJob {
  id: string;
  name: string;
  slots: number[];
}

export interface DigestInput {
  project: string;
  runs: StoredRun[];
  missed: MissedJob[];
  timeZone: string;
}

const PROBLEMS = ['failed', 'error', 'timeout', 'limit'];
const MAX_LISTED = 8;

function count(runs: StoredRun[], status: string): number {
  return runs.filter((r) => r.status === status).length;
}

function firstLine(text: string | undefined, max = 140): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The daily health summary for one project: a headline for the channel and details for its thread,
 * or null when nothing ran and nothing was missed (a quiet project stays quiet).
 */
export function buildDigest({
  project,
  runs,
  missed,
  timeZone,
}: DigestInput): { headline: string; details: string } | null {
  const missedSlots = missed.reduce((n, m) => n + m.slots.length, 0);
  if (runs.length === 0 && missedSlots === 0) return null;

  const jobs = runs.filter((r) => r.kind === 'job');
  const chats = runs.filter((r) => r.kind === 'chat');
  const problems = runs.filter((r) => PROBLEMS.includes(r.status));
  const peak = Math.max(0, ...runs.map((r) => r.rateLimitUtilization ?? 0));
  const cost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const healthy = problems.length === 0 && missedSlots === 0;

  const headline =
    `${healthy ? '🩺' : '⚠️'} *Daily health · ${project}* · last 24h: ` +
    `${jobs.length} job runs (${count(jobs, 'ok')} ok, ${count(jobs, 'silent')} silent` +
    `${problems.length ? `, ${problems.length} with problems` : ''}), ${chats.length} chat turns` +
    `${missedSlots ? ` · *${missedSlots} missed*` : ''} · peak 5h usage ${Math.round(peak * 100)}%`;

  const when = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const sections: string[] = [];
  if (problems.length) {
    sections.push(
      `*Problems*\n${problems
        .slice(-MAX_LISTED)
        .map(
          (r) =>
            `• \`${r.jobId ?? 'chat'}\` ${r.status} at ${when(r.startedAt)}: ${firstLine(r.error) || 'no error text'}`,
        )
        .join('\n')}`,
    );
  }
  if (missedSlots) {
    sections.push(
      `*Missed runs* (scheduled but never started)\n${missed
        .filter((m) => m.slots.length)
        .slice(0, MAX_LISTED)
        .map((m) => `• \`${m.id}\` ${m.name}: ${m.slots.map(when).join(', ')}`)
        .join('\n')}`,
    );
  }
  const slowest = [...jobs]
    .filter((r) => r.status !== 'silent')
    .sort((a, b) => b.endedAt - b.startedAt - (a.endedAt - a.startedAt))
    .slice(0, 3);
  if (slowest.length) {
    sections.push(
      `*Slowest jobs*\n${slowest.map((r) => `• \`${r.jobId}\` ${formatDuration(r.endedAt - r.startedAt)}`).join('\n')}`,
    );
  }
  const tokens = runs.reduce((sum, r) => sum + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
  const cacheRead = runs.reduce((sum, r) => sum + (r.cacheReadTokens ?? 0), 0);
  sections.push(
    `*Usage*\n• ${(tokens / 1000).toFixed(1)}k tokens in/out, ${(cacheRead / 1_000_000).toFixed(2)}M cache reads` +
      `\n• Peak 5-hour window usage: ${Math.round(peak * 100)}%` +
      (cost > 0 ? `\n• List-price cost: $${cost.toFixed(2)} (billed only for projects on API billing)` : ''),
  );
  return { headline, details: sections.join('\n\n') };
}
