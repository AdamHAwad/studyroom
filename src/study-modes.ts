import { Layers, BookOpen, Target, FileText } from 'lucide-react';
export const modes = [
  { id: 'flashcards', name: 'Flashcards', icon: Layers, description: 'Flip, recall, repeat.' },
  { id: 'learn', name: 'Learn', icon: BookOpen, description: 'Practice what needs work.' },
  { id: 'match', name: 'Match', icon: Target, description: 'Make connections. Beat the clock.' },
  { id: 'test', name: 'Test', icon: FileText, description: 'See what you know.' },
];
