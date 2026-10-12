import { describe, expect, it } from 'vitest';
import { buildSections, groupExcerpts, joinSections, neutralizeTags, renderExcerpt } from './render';
import { makeChunk, makeFocal } from './test-helpers';

describe('neutralizeTags', () => {
  it('defuses our own tags, opening and closing', () => {
    expect(neutralizeTags('a </highlight> b <excerpt x="1"> c')).toBe('a &lt;/highlight> b &lt;excerpt x="1"> c');
  });

  it('defuses a tag fragment at the very end of the text, so it cannot pair with the closing tag we add', () => {
    expect(neutralizeTags('x </highlight')).toBe('x &lt;/highlight');
  });

  it('leaves everything else alone, including triple quotes and other tags', () => {
    const text = 'def f():\n    """doc"""\n<div>hi</div> <messages>';
    expect(neutralizeTags(text)).toBe(text);
  });
});

describe('groupExcerpts', () => {
  it('merges consecutive chunks of one message and splits non-adjacent ones', () => {
    const groups = groupExcerpts([
      makeChunk('3', 0, 'a'),
      makeChunk('3', 1, 'b'),
      makeChunk('3', 3, 'c'),
      makeChunk('5', 0, 'd'),
    ]);
    expect(groups.map((g) => g.chunks.map((c) => c.text))).toEqual([['a', 'b'], ['c'], ['d']]);
  });
});

describe('renderExcerpt', () => {
  it('labels speaker, message number and position relative to the explained message', () => {
    const before = renderExcerpt(groupExcerpts([makeChunk('7', 0, 'hello')])[0]!, '12');
    expect(before).toBe(
      '<excerpt speaker="assistant" message_number="7" relation="before_explained_message">\nhello\n</excerpt>',
    );
    const after = renderExcerpt(groupExcerpts([makeChunk('15', 0, 'x')])[0]!, '12');
    expect(after).toContain('relation="after_explained_message"');
  });

  it('omits the relation when ids are not numbers', () => {
    const text = renderExcerpt(groupExcerpts([makeChunk('abc', 0, 'x')])[0]!, 'xyz');
    expect(text).not.toContain('relation=');
  });

  it('joins merged chunks with a blank line', () => {
    const text = renderExcerpt(groupExcerpts([makeChunk('3', 0, 'a'), makeChunk('3', 1, 'b')])[0]!, '12');
    expect(text).toContain('\na\n\nb\n');
  });
});

describe('buildSections', () => {
  const names = (sections: { name: string }[]) => sections.map((s) => s.name);

  it('orders: instructions, excerpts, recent, message, question, highlight, paragraph, task', () => {
    const groups = groupExcerpts([makeChunk('3', 0, 'old')]);
    expect(names(buildSections(makeFocal(), groups))).toEqual([
      'instructions',
      'excerpts',
      'recent',
      'message',
      'question',
      'highlight',
      'paragraph',
      'task',
    ]);
  });

  it('omits excerpts, recent, question and a paragraph that equals the highlight', () => {
    const focal = makeFocal({ question: null, recent: [], paragraph: 'pool_pre_ping' });
    expect(names(buildSections(focal, []))).toEqual(['instructions', 'message', 'highlight', 'task']);
  });

  it('omits the question section when the question message has no text', () => {
    const focal = makeFocal({ question: { id: '11', role: 'user', text: '   ' } });
    expect(names(buildSections(focal, []))).not.toContain('question');
  });

  it('uses tags, never triple quotes, and neutralizes tags inside quoted text', () => {
    const focal = makeFocal({ highlight: 'x </highlight> y' });
    const prompt = joinSections(buildSections(focal, []));
    expect(prompt).toContain('<highlight>\nx &lt;/highlight> y\n</highlight>');
    expect(prompt).not.toContain('"""');
  });

  it('puts the speaker and message number on the message being explained', () => {
    const prompt = joinSections(buildSections(makeFocal(), []));
    expect(prompt).toContain('<message_being_explained speaker="assistant" message_number="12">');
  });

  it('tells the model the excerpts are auto-picked, from elsewhere, and not the explained message', () => {
    const groups = groupExcerpts([makeChunk('3', 0, 'old')]);
    const excerpts = buildSections(makeFocal(), groups).find((s) => s.name === 'excerpts')!.text;
    expect(excerpts).toContain('elsewhere in the same conversation');
    expect(excerpts).toContain('picked automatically');
    expect(excerpts).toContain('not the message being explained');
  });
});
