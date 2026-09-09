import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..', '..');
const README = join(ROOT, 'README.md');
const INTEGRATIONS = join(ROOT, 'docs', 'integrations.md');
const RUNNER = join(ROOT, 'test', 'integrations', 'run.mjs');

/**
 * The support table says which frameworks work and points at CI for the ones a check covers. This
 * holds those rows to the runner, because a row that cannot be checked is worse than no row: these
 * exist to be read by people who maintain the frameworks they name, and the first thing such a
 * reader does is look.
 *
 * Two failures it is built to catch, both of which have already happened here:
 *
 *   - **A cited check that does not exist**, or an `exact=N` that disagrees with the exchange count
 *     the check asserts. Easy to introduce by copying a row.
 *   - **A row that outlives its reason.** The CrewAI row said all of CrewAI, Aider and OpenHands
 *     route through LiteLLM, and CrewAI 1.x stopped doing that — LiteLLM became an optional extra
 *     and CrewAI grew native providers. Capture went on working, so nothing failed; the sentence
 *     explaining why had simply been wrong for a major version. Only running CrewAI itself found
 *     it, which is why the row now cites a check that runs CrewAI.
 *
 * So the assertions below are not only "does the number match". They pin the distinction each row
 * has to keep making: whether CI drives the framework, or the layer beneath it.
 */
describe('the support table is backed by checks that exist', () => {
  async function sources() {
    const [readme, integrations, runner] = await Promise.all([
      readFile(README, 'utf8'),
      readFile(INTEGRATIONS, 'utf8'),
      readFile(RUNNER, 'utf8'),
    ]);
    /** Every check the runner defines, and the exchange count it asserts. */
    const checks = new Map<string, number>();
    for (const m of runner.matchAll(/id: '([^']+)'[\s\S]*?exchanges: (\d+)/g)) {
      checks.set(m[1]!, Number(m[2]));
    }
    /** The anchors GitHub generates from `docs/integrations.md` headings. */
    const anchors = new Set(
      [...integrations.matchAll(/^## (.+)$/gm)].map((m) =>
        m[1]!
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .trim()
          .replace(/\s+/g, '-'),
      ),
    );
    const rows = readme.split('\n').filter((l) => l.startsWith('| **') && l.includes('in CI'));
    return { readme, checks, anchors, rows };
  }

  /** The row naming this framework, or undefined. */
  function rowFor(rows: string[], framework: string): string | undefined {
    return rows.find((r) => r.startsWith(`| **${framework}**`));
  }

  const CITED = [
    { framework: 'OpenAI Agents SDK', checks: ['openai-agents'], exact: 1 },
    { framework: 'Vercel AI SDK', checks: ['fetch-hook'], exact: 1 },
    {
      framework: 'LangGraph / LangChain',
      checks: ['langgraph-stream', 'langgraph-tools'],
      exact: 2,
    },
    { framework: 'CrewAI', checks: ['crewai'], exact: 1 },
    { framework: 'Aider', checks: ['litellm'], exact: 1 },
    { framework: 'browser-use', checks: ['browser-use'], exact: 1 },
  ];

  it.each(CITED)('$framework cites a check that exists and agrees on the count', async (c) => {
    const { checks, rows } = await sources();
    const row = rowFor(rows, c.framework);
    expect(row, `no CI-citing row for ${c.framework}`).toBeDefined();

    for (const id of c.checks) {
      expect(checks.has(id), `run.mjs has no check called ${id}`).toBe(true);
      expect(checks.get(id), `${id} asserts a different exchange count`).toBe(c.exact);
    }
    expect(row).toContain(`\`exact=${c.exact}\``);
  });

  it('every docs/integrations.md anchor a row links to resolves', async () => {
    const { readme, anchors } = await sources();
    const linked = [...readme.matchAll(/\(docs\/integrations\.md#([\w-]+)\)/g)].map((m) => m[1]!);
    expect(linked.length).toBeGreaterThan(0);
    for (const anchor of linked) {
      expect(anchors.has(anchor), `#${anchor} is not a heading in docs/integrations.md`).toBe(true);
    }
  });

  /**
   * The honesty rule, which is the part that keeps these rows worth citing.
   *
   * A check either drives the framework or drives the layer beneath it, and the row has to say
   * which. `litellm` runs `litellm.completion()`, so the row it backs may not claim CI runs Aider.
   * `crewai` runs a real Crew, so that row may not still say CrewAI rides on LiteLLM — it does not.
   */
  it('a row claims only what its check actually runs', async () => {
    const { rows } = await sources();

    const crewai = rowFor(rows, 'CrewAI');
    expect(crewai, 'CrewAI has no row').toBeDefined();
    expect(crewai, 'the CrewAI row still says it routes through LiteLLM').not.toMatch(/LiteLLM/i);
    expect(crewai, 'the CrewAI row does not say the check runs CrewAI itself').toMatch(
      /Agent.*Task.*Crew/,
    );

    const aider = rowFor(rows, 'Aider');
    expect(aider, 'Aider has no row').toBeDefined();
    expect(aider, 'the Aider row must name the layer its check actually runs').toMatch(/LiteLLM/);

    const agents = rowFor(rows, 'OpenAI Agents SDK');
    expect(agents, 'the Agents SDK row must name the Responses API its check runs on').toMatch(
      /Responses API/,
    );

    const browser = rowFor(rows, 'browser-use');
    expect(browser, 'the browser-use check drives no browser, and the row must say so').toMatch(
      /LLM layer only/,
    );
  });
});
