export type Course = {
  id: string;
  name: string;
  code: string;
  color: string;
  description: string;
  createdAt: string;
  archived: boolean;
};
export type Source = {
  id: string;
  courseId: string;
  name: string;
  size: number;
  kind: string;
  textPath: string;
  path: string;
  status: string;
  error: string | null;
  createdAt: string;
};
export type Citation = {
  sourceId: string;
  locator: string;
  quote: string;
  assetId?: string | null;
};
export type Card = {
  id: string;
  setId: string;
  term: string;
  definition: string;
  question: string;
  distractors: string[];
  explanation: string;
  topic: string;
  sources: Citation[];
  starred: boolean;
  version: number;
  position: number;
  aliases: string[];
  image?: {
    assetId: string;
    cropId?: string;
    side: 'question' | 'answer';
    alt: string;
    caption: string;
    reason: string;
    matchUsable: boolean;
    revealsAnswer: boolean;
    crop: number[] | null;
  } | null;
};
export type StudySet = {
  id: string;
  courseId: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  origin: string;
  warnings: string[];
  coverage?: any;
  cardCount?: number;
  cards?: Card[];
};
export type Attempt = {
  id: string;
  sessionId: string;
  cardId: string;
  setId: string;
  courseId: string;
  mode: string;
  kind: string;
  correct: boolean | null;
  response: string;
  durationMs: number;
  createdAt: string;
  cardVersion: number;
};
export type CardProgress = {
  cardId: string;
  seen: number;
  objectiveAttempts: number;
  correct: number;
  recallAttempts: number;
  recognitionAttempts: number;
  selfRatings: number;
  lastCorrect: boolean | null;
  lastStudied: string | null;
  dueAt: string | null;
  intervalDays: number;
  streak: number;
  status: 'new' | 'learning' | 'familiar' | 'retained';
};
export type Job = {
  id: string;
  kind: 'set' | 'chat' | 'review' | 'practice-exam' | 'retrieval-packet';
  courseId: string | null;
  status: string;
  stage: string;
  progress: number;
  error: string | null;
  resultId: string | null;
  createdAt: string;
  updatedAt: string;
  payload: any;
};
export type ChatMessage = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  jobId: string | null;
  actions: { label: string; path: string; reason: string }[];
  evidence: string[];
};
export type Conversation = {
  id: string;
  courseId: string | null;
  title: string;
  createdAt: string;
};
export type AppData = {
  courses: Course[];
  sets: StudySet[];
  documents: StudyDocument[];
  jobs: Job[];
  progress: CardProgress[];
  stats: {
    attempts: number;
    accuracy: number | null;
    studyDays: number;
    streak: number;
    due: number;
    retained: number;
    totalCards: number;
    minutes: number;
  };
  activity: { date: string; count: number; correct: number }[];
  settings: Record<string, string>;
};

export type DocumentKind = 'practice-exam' | 'retrieval-packet';
export type RetrievalTerm = {
  term: string;
  topic: string;
  cue: string;
  definition: string;
  example: string;
  memoryAid: string;
  compareWith: string;
  importance: number;
  refs: string[];
};
export type ExamQuestion = {
  prompt: string;
  stimulus: string;
  options: string[];
  answer: string;
  explanation: string;
  points: number;
  lines: number;
  refs: string[];
  visualRef: string;
  parts: { label: string; prompt: string; answer: string; points: number; lines: number }[];
};
export type ExamSection = {
  title: string;
  instructions: string;
  kind: string;
  count: number;
  pointsEach: number;
  questions: ExamQuestion[];
};
export type StudyDocument = {
  id: string;
  courseId: string;
  kind: DocumentKind;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  version: number;
  sourceIds: string[];
  referenceSourceIds: string[];
  instructions: string;
  generationJobId: string;
  warnings: string[];
  content: {
    overview: string[];
    essentialQuestions: string[];
    terms: RetrievalTerm[];
    omittedTerms: string[];
    examInstructions: string;
    durationMinutes: number;
    style: {
      font: 'serif' | 'sans-serif';
      columns: number;
      optionLayout: 'stacked' | 'inline';
      headingCase: 'normal' | 'uppercase';
    };
    sections: ExamSection[];
    evidence: {
      ref: string;
      sourceId: string;
      name: string;
      locator: string;
      text: string;
      assetId?: string;
    }[];
  };
};
