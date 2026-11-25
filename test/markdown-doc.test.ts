import { describe, expect, it } from 'vitest';
import type { CodeRepo } from '../src/code/repo.js';
import { codeFilePage, codeLink, isMarkdown } from '../src/http/code.js';
import type { DashboardContext } from '../src/http/dashboard.js';
import { frontmatter, markdownDoc } from '../src/http/markdown-doc.js';

const SKILL = `---
name: linkedin-topic-discovery
description: "Discover and draft LinkedIn posts"
metadata:
  tags: [content, linkedin]
---

# LinkedIn Topic Discovery

This skill searches for topics,
drafts posts and **asks** Abhijeet.

## 1. Workflow

1. **Run Gate.** It skips the run while a card waits:
   - \`MODE: DISCOVER\`: discover, then ask.
   - \`MODE: ASK\`: ask only.

2. **Discover mode.** See [the rules](references/rules.md#reach) and [setup](../README.md).

\`\`\`bash
python3 gate.py
\`\`\`

3. Ask with a card.

| Kind | Where |
| --- | --- |
| post | Approvals |

> Never publish yourself.

- [x] done
- [ ] todo

<script>alert(1)</script>
`;

const resolve = (href: string) => codeLink({ name: 'jobs' } as CodeRepo, '.agents/skills/li/SKILL.md', href);

describe('Markdown files as documents (Code page)', () => {
  const html = markdownDoc(SKILL, resolve);

  it('shows the frontmatter as a table and the rest as a document', () => {
    expect(html).toContain('<tr><th>name</th><td>linkedin-topic-discovery</td></tr>');
    expect(html).toContain('<tr><th>description</th><td>Discover and draft LinkedIn posts</td></tr>');
    expect(html).toContain('<tr><th>metadata</th><td>tags: [content, linkedin]</td></tr>');
    expect(html).not.toContain('---');
    expect(html).toContain('<h2 id="linkedin-topic-discovery">LinkedIn Topic Discovery</h2>');
    expect(html).toContain('<h3 id="1-workflow">1. Workflow</h3>');
    // Wrapped lines are one paragraph.
    expect(html).toContain('<p>This skill searches for topics, drafts posts and <b>asks</b> Abhijeet.</p>');
  });

  it('keeps numbered lists going across blank lines and nests bullets under their item', () => {
    expect(html).toContain(
      '<ol class="md"><li><b>Run Gate.</b> It skips the run while a card waits:<ul class="md"><li><code>MODE: DISCOVER</code>: discover, then ask.</li><li><code>MODE: ASK</code>: ask only.</li></ul></li><li><b>Discover mode.</b>',
    );
    expect(html).toContain('<pre class="doc-code">python3 gate.py</pre>');
    // After the code block the list goes on at its own number.
    expect(html).toContain('<ol class="md" start="3"><li>Ask with a card.</li></ol>');
    expect(html).toContain('<li>☑ done</li><li>☐ todo</li>');
  });

  it('renders tables and quotes, and never raw HTML', () => {
    expect(html).toContain('<th>Kind</th><th>Where</th>');
    expect(html).toContain(
      '<blockquote class="md"><div class="doc"><p>Never publish yourself.</p></div></blockquote>',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('opens relative links in the Code page, and nothing outside the repo', () => {
    expect(html).toContain(
      '<a href="/code/jobs/file?path=.agents%2Fskills%2Fli%2Freferences%2Frules.md#reach">the rules</a>',
    );
    expect(resolve('../README.md')).toBe('/code/jobs/file?path=.agents%2Fskills%2FREADME.md');
    expect(resolve('/docs/')).toBe('/code/jobs/files?path=docs');
    expect(resolve('#setup')).toBe('#setup');
    expect(resolve('../../../../etc/passwd')).toBeUndefined();
    expect(resolve('mailto:a@b.c')).toBeUndefined();
    expect(markdownDoc('[x](../../../../../secret)', resolve)).toContain('<p>x</p>');
  });

  it('reads frontmatter only at the very start', () => {
    expect(frontmatter('# Title\n---\na: b\n---\n').meta).toEqual([]);
    expect(frontmatter('---\ndescription: >\n  two\n  lines\n---\nbody')).toEqual({
      meta: [['description', 'two lines']],
      body: 'body',
    });
  });
});

describe('Code page file view', () => {
  const ctx = { projects: [], timeZone: 'UTC', agentName: 'Jarvis' } as unknown as DashboardContext;
  const repo = { name: 'jobs', title: 'Support', dir: '/r/jobs' } as unknown as CodeRepo;
  const file = '.agents/skills/li/SKILL.md';
  const view = { text: SKILL, size: SKILL.length };

  it('shows Markdown formatted, with the source a tap away', () => {
    const page = codeFilePage(ctx, repo, file, view, undefined, false);
    expect(page).toContain('<div class="doc">');
    expect(page).toContain(
      'class="chip on" href="/code/jobs/file?path=.agents%2Fskills%2Fli%2FSKILL.md" aria-current="page">Formatted</a>',
    );
    expect(page).toContain(
      'href="/code/jobs/file?path=.agents%2Fskills%2Fli%2FSKILL.md&amp;view=source">Source</a>',
    );
    // A line link goes to the source.
    expect(page).toContain(
      'location.replace("/code/jobs/file?path=.agents%2Fskills%2Fli%2FSKILL.md&view=source" + location.hash)',
    );

    const source = codeFilePage(ctx, repo, file, view, undefined, false, 'source');
    expect(source).toContain('<div id="L1"><i>1</i><code>---</code></div>');
    expect(source).not.toContain('<div class="doc">');
    expect(source).not.toContain('location.replace');
  });

  it('leaves other files as numbered lines, with no switch', () => {
    expect(isMarkdown('a/README.markdown')).toBe(true);
    expect(isMarkdown('a/b.mdx')).toBe(false);
    const page = codeFilePage(ctx, repo, 'src/a.ts', { text: 'const a = 1;\n', size: 13 }, undefined, false);
    expect(page).toContain('<div id="L1"><i>1</i><code>const a = 1;</code></div>');
    expect(page).not.toContain('Formatted</a>');
  });
});
