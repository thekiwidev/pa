// Pure. One entry on the Important links page.
//
// Written so that scanning the page by eye finds the link: a heading with
// what it is, then the link, what it is for, and when it was saved.

export function importantLinkMarkdown(args: { url: string; about: string; title?: string; savedAt: string }): string {
  const heading = (args.title?.trim() || args.about.trim().split(/[.\n]/)[0] || args.url).slice(0, 100);
  return [
    `### ${heading}`,
    `- Link: ${args.url}`,
    `- What it is: ${args.about.trim()}`,
    `- Saved: ${args.savedAt}`,
  ].join("\n");
}
