import { MAX_IDEA_CHAT_CONTEXT_LENGTH, type Idea } from '../ideas.ts';

function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  const suffix = '\n[…truncated]';
  const end = Math.max(0, limit - suffix.length);
  const next = text.charCodeAt(end);
  return text.slice(0, next >= 0xdc00 && next <= 0xdfff ? Math.max(0, end - 1) : end) + suffix;
}

export function formatIdeaContext(idea: Idea) {
  const title = idea.title.trim() || 'Untitled idea';
  const text = idea.body.trim();
  const links = idea.links.map(link => {
    const lines =
      link.line == null
        ? ''
        : `:${link.line}${link.endLine && link.endLine !== link.line ? `–${link.endLine}` : ''}`;
    const side = link.side === 'head' ? ' (HEAD)' : '';
    return `${JSON.stringify(link.path)}${lines}${side}`;
  });
  const header = `Idea: ${JSON.stringify(title)}`;
  const locations = links.length
    ? `\n\nLinked files:\n${clip(links.map(link => `- ${link}`).join('\n'), 5000)}`
    : '';
  const markdown = text ? '\n\nIdea Markdown:\n' : '';
  const budget = MAX_IDEA_CHAT_CONTEXT_LENGTH - header.length - locations.length - markdown.length;
  const body = clip(text, budget);
  const excerpts = idea.links.flatMap((link, index) =>
    link.excerpt ? [`${links[index]}${link.truncated ? ' (excerpt)' : ''}\n${link.excerpt}`] : [],
  );
  const excerptHeading = '\n\nCaptured code:\n';
  const remaining = budget - body.length - excerptHeading.length;
  const code =
    excerpts.length && remaining >= 100
      ? excerptHeading + clip(excerpts.join('\n\n'), remaining)
      : '';
  return `${header}${locations}${markdown}${body}${code}`;
}
