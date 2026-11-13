export type IdeaLink = {
  path: string;
  line?: number;
  endLine?: number;
  side?: 'working' | 'head';
  excerpt?: string;
  truncated?: boolean;
};

export type Idea = {
  id: string;
  title: string;
  body: string;
  links: IdeaLink[];
  createdAt: number;
  updatedAt: number;
};

export type IdeaChange = { type: 'upsert'; idea: Idea } | { type: 'delete'; id: string };

export const IDEA_FILE_DRAG_TYPE = 'application/x-diffpane-file';
export const MAX_IDEA_TITLE_LENGTH = 200;
export const MAX_IDEA_BODY_LENGTH = 100_000;
export const MAX_IDEA_LINKS = 200;
export const MAX_IDEA_EXCERPT_LENGTH = 2400;
export const MAX_IDEA_CHAT_CONTEXT_LENGTH = 20_000;
