import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  X,
  ArrowLeft,
  ArrowRight,
  RotateCcw,
  Shuffle,
  Star,
  Volume2,
  Settings,
  Check,
  Keyboard,
  Play,
  Pause,
  Layers,
  BookOpen,
  Target,
  FileText,
  ChevronDown,
  Clock3,
  CheckCircle2,
  ArrowUpRight,
  LoaderCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { api, post, patch, shuffle, seededShuffle } from './api';
import { useApp } from './App';
import { Modal, Loading, Empty } from './ui';
import { modes } from './study-modes';
import CardVisual from './components/CardVisual';
import RichText from './RichText';
import type { Card, StudySet } from './types';
type QuestionKind = 'mcq' | 'written' | 'tf' | 'match';
type MatchBlock = {
  stem: string;
  items: { cardId: string; text: string; answer: string }[];
  choices: { label: string; text: string }[];
  coveredIds: string[];
};
type Question = Card & {
  options: string[];
  answerKind?: QuestionKind;
  prompt?: string;
  answer?: string;
  answerSide?: 'term' | 'definition';
  pair?: string;
  match?: MatchBlock;
};
type Session = {
  id: string;
  setId: string;
  mode: string;
  cards: Question[];
  settings: any;
  state: any;
  createdAt: string;
  completedAt: string | null;
  result?: any;
  bestTime?: number | null;
};
export default function Study() {
  const { setId, mode } = useParams();
  const [params] = useSearchParams();
  const { refresh } = useApp();
  const [set, setSet] = useState<StudySet | null>(null),
    [session, setSession] = useState<Session | null>(null),
    [resume, setResume] = useState<Session | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [count, setCount] = useState(10),
    [starred, setStarred] = useState(false),
    [direction, setDirection] = useState('term'),
    [questionTypes, setQuestionTypes] = useState<QuestionKind[]>(['mcq', 'written']),
    [random, setRandom] = useState(false),
    [sorting, setSorting] = useState(true),
    [audio, setAudio] = useState(false);
  const navigate = useNavigate();
  const meta = modes.find((m) => m.id === mode);
  useEffect(() => {
    setReady(false);
    setSession(null);
    setError('');
    Promise.all([
      api<StudySet>(`/sets/${setId}`),
      api<Session[]>(`/sessions?setId=${setId}&mode=${mode}`),
    ])
      .then(([s, ss]) => {
        setSet(s);
        setCount(s.cards?.length || 1);
        setQuestionTypes(mode === 'test' ? ['mcq', 'written', 'tf'] : ['mcq', 'written']);
        setResume(params.get('focus') ? null : ss[0] || null);
        setReady(true);
      })
      .catch((e) => {
        setError(e.message);
        setReady(true);
      });
  }, [setId, mode, params]);
  function toggleQuestionType(kind: QuestionKind) {
    setQuestionTypes((prev) =>
      prev.includes(kind)
        ? prev.length > 1
          ? prev.filter((k) => k !== kind)
          : prev
        : [...prev, kind],
    );
  }
  async function start(focusIds?: string[], previous?: any) {
    setBusy(true);
    try {
      const s = await post<Session>('/sessions', {
        setId,
        mode,
        focusIds,
        focus: params.get('focus') || undefined,
        starred: previous?.starred ?? starred,
        direction: previous?.direction ?? direction,
        questionTypes: previous ? previous.questionTypes : questionTypes,
        questionType: previous ? previous.questionType : undefined,
        shuffle: previous?.shuffle ?? random,
        sorting: previous?.sorting ?? sorting,
        audio: previous?.audio ?? audio,
        count: mode === 'test' ? (previous?.count ?? count) : undefined,
      });
      setSession(s);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const save = useCallback(
    async (state: any, completed = false) => {
      if (!session) return;
      const updated = await patch<Session>(`/sessions/${session.id}`, { state, completed });
      setSession(updated);
      if (completed) void refresh();
    },
    [session, refresh],
  );
  if (!meta)
    return (
      <Empty
        title="Choose a study mode"
        description="Flashcards, Learn, Match, and Test are available from your set."
      />
    );
  return (
    <div className="study-page">
      <header className="study-header">
        <Link to={`/sets/${setId}`} className="study-mode-title">
          <meta.icon size={24} />
          <strong>{meta.name}</strong>
        </Link>
        <Link to={`/sets/${setId}`} className="study-set-name">
          {set?.title || 'Your study set'}
        </Link>
        <Link to={`/sets/${setId}`} className="icon-button bordered" aria-label="Close study mode">
          <X size={20} />
        </Link>
      </header>
      {!ready ? (
        <Loading />
      ) : error ? (
        <Empty title="Couldn't start studying" description={error} />
      ) : !session ? (
        <div className="study-setup">
          <div className={`setup-icon ${mode}`}>
            <meta.icon size={34} />
          </div>
          <h1>
            {mode === 'flashcards'
              ? 'A fresh look at what you know.'
              : mode === 'learn'
                ? 'Let’s make it stick.'
                : mode === 'match'
                  ? 'Ready, set, match.'
                  : 'Put your knowledge to the test.'}
          </h1>
          <p>
            {mode === 'flashcards'
              ? 'Think of your answer, then flip the card. Sort what you know from what needs another look.'
              : mode === 'learn'
                ? 'Work through the whole set in one round. Missed questions return until you know them, with a checkpoint every 10 answers.'
                : mode === 'match'
                  ? 'Match each term with its answer. Clear all the tiles as fast as you can. A mismatch adds 2 seconds.'
                  : 'Build a practice test with the question types you choose. You’ll see your score and explanations after you submit.'}
          </p>
          <div className="setup-options">
            {mode === 'test' && (
              <label className="option-row">
                Number of questions
                <input
                  aria-label="Number of questions"
                  type="number"
                  min={1}
                  max={set?.cards?.length || 1}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
            )}
            {(mode === 'learn' || mode === 'test') && (
              <>
                <label className="option-row">
                  Multiple choice
                  <input
                    className="switch"
                    type="checkbox"
                    checked={questionTypes.includes('mcq')}
                    onChange={() => toggleQuestionType('mcq')}
                  />
                </label>
                <label className="option-row">
                  Written questions
                  <input
                    className="switch"
                    type="checkbox"
                    checked={questionTypes.includes('written')}
                    onChange={() => toggleQuestionType('written')}
                  />
                </label>
                <label className="option-row">
                  True or false
                  <input
                    className="switch"
                    type="checkbox"
                    checked={questionTypes.includes('tf')}
                    onChange={() => toggleQuestionType('tf')}
                  />
                </label>
                {mode === 'learn' && (
                  <label className="option-row">
                    Matching
                    <input
                      className="switch"
                      type="checkbox"
                      checked={questionTypes.includes('match')}
                      onChange={() => toggleQuestionType('match')}
                    />
                  </label>
                )}
                <label className="option-row">
                  Answer with
                  <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="term">Definitions</option>
                    <option value="definition">Terms</option>
                  </select>
                </label>
              </>
            )}
            {mode === 'flashcards' && (
              <>
                <label className="option-row">
                  Show first
                  <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                    <option value="term">Term / question</option>
                    <option value="definition">Definition / answer</option>
                  </select>
                </label>
                <label className="option-row">
                  Shuffle cards
                  <input
                    className="switch"
                    type="checkbox"
                    checked={random}
                    onChange={(e) => setRandom(e.target.checked)}
                  />
                </label>
                <label className="option-row">
                  Sort into “Know” and “Still learning”
                  <input
                    className="switch"
                    type="checkbox"
                    checked={sorting}
                    onChange={(e) => setSorting(e.target.checked)}
                  />
                </label>
                <label className="option-row">
                  Read cards aloud
                  <input
                    className="switch"
                    type="checkbox"
                    checked={audio}
                    onChange={(e) => setAudio(e.target.checked)}
                  />
                </label>
              </>
            )}
            {mode === 'learn' && (
              <label className="option-row">
                Shuffle terms
                <input
                  className="switch"
                  type="checkbox"
                  checked={random}
                  onChange={(e) => setRandom(e.target.checked)}
                />
              </label>
            )}
            <label className="option-row">
              Study only starred terms
              <input
                className="switch"
                type="checkbox"
                checked={starred}
                onChange={(e) => setStarred(e.target.checked)}
              />
            </label>
          </div>
          {resume && (
            <button className="button secondary full" onClick={() => setSession(resume)}>
              Resume saved {meta.name.toLowerCase()} session
              <ArrowRight size={18} />
            </button>
          )}
          <button className="button primary full" disabled={busy} onClick={() => void start()}>
            {busy ? <LoaderCircle className="spin" size={19} /> : null}
            {resume ? 'Start a new session' : `Start ${meta.name.toLowerCase()}`}
            <ArrowRight size={19} />
          </button>
          <small className="setup-footnote">
            {set?.cards?.length} terms in this set · Progress saves as you go
          </small>
        </div>
      ) : session.completedAt && mode !== 'test' ? (
        <SessionResult
          session={session}
          onRestart={() => {
            setSession(null);
            setResume(null);
          }}
          onKeepStudying={() => void start(undefined, session.settings)}
          onReviewMissed={() =>
            void start(
              Object.entries(session.state.ratings || {})
                .filter(([, v]) => v === false)
                .map(([id]) => id),
            )
          }
        />
      ) : mode === 'flashcards' ? (
        <Flashcards session={session} save={save} />
      ) : mode === 'learn' ? (
        <Learn session={session} save={save} />
      ) : mode === 'match' ? (
        <Match session={session} save={save} />
      ) : (
        <Test session={session} onUpdate={setSession} />
      )}
    </div>
  );
}
async function attempt(
  session: Session,
  card: Card,
  kind: string,
  response: string,
  durationMs: number,
  extra: any = {},
  cardId = card.id,
) {
  const payload = {
    id: crypto.randomUUID(),
    sessionId: session.id,
    cardId,
    kind,
    response,
    durationMs: Math.max(0, Math.min(durationMs, 86400000)),
    ...extra,
  };
  try {
    return await post('/attempts', payload);
  } catch (e) {
    if (e instanceof TypeError) return await post('/attempts', payload);
    throw e;
  }
}
function promptOf(card: Question) {
  return card.prompt ?? (card.answerKind === 'written' ? card.term : card.question || card.term);
}
function answerOf(card: Question) {
  return card.answer ?? card.definition;
}
function Flashcards({
  session,
  save,
}: {
  session: Session;
  save: (s: any, complete?: boolean) => Promise<void>;
}) {
  const [flipped, setFlipped] = useState(false),
    [busy, setBusy] = useState(false),
    [autoplay, setAutoplay] = useState(false),
    [showHelp, setShowHelp] = useState(false),
    [star, setStar] = useState<Record<string, boolean>>({});
  const since = useRef(Date.now());
  const state = session.state,
    index = state.index || 0,
    card = session.cards[index];
  const ratings = state.ratings || {};
  const known = Object.values(ratings).filter(Boolean).length;
  const sorting = session.settings.sorting !== false;
  const audio = session.settings.audio === true;
  const text =
    flipped !== (session.settings.direction === 'definition') ? card.definition : card.term;
  async function move(delta: number, rating?: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      if (rating !== undefined)
        await attempt(
          session,
          card,
          'self',
          rating ? 'Know' : 'Still learning',
          Date.now() - since.current,
          { selfCorrect: rating },
        );
      const nextRatings = rating === undefined ? ratings : { ...ratings, [card.id]: rating };
      const next = {
        ...state,
        index: Math.min(session.cards.length - 1, Math.max(0, index + delta)),
        ratings: nextRatings,
      };
      await save(next, index + delta >= session.cards.length);
      setFlipped(false);
      since.current = Date.now();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        showHelp
      )
        return;
      if (e.code === 'Space') {
        e.preventDefault();
        setFlipped((f) => !f);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        void move(1);
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        void move(-1);
      }
      if (e.key === '1' && flipped && sorting) void move(1, false);
      if (e.key === '2' && flipped && sorting) void move(1, true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => {
    if (!autoplay) return;
    const timer = setTimeout(() => {
      if (!flipped) setFlipped(true);
      else void move(1);
    }, 3000);
    return () => clearTimeout(timer);
  }, [autoplay, flipped, index]);
  useEffect(() => {
    if (!audio) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }, [audio, text]);
  return (
    <div className="flashcard-stage">
      <div className="flashcard-status">
        <span className="learning-count">
          Still learning <b>{Object.values(ratings).filter((v) => v === false).length}</b>
        </span>
        <span className="muted">
          {index + 1} / {session.cards.length}
        </span>
        <span className="know-count">
          <b>{known}</b> Know
        </span>
      </div>
      <div className="flip-perspective">
        <motion.div
          className="flip-card"
          animate={{ rotateX: flipped ? 180 : 0 }}
          transition={{ duration: 0.35, ease: 'easeInOut' }}
        >
          <div className="card-face front" aria-hidden={flipped} inert={flipped}>
            <span className="card-side-label">
              {session.settings.direction === 'definition' ? 'DEFINITION' : 'TERM'}
            </span>
            <button
              className="flip-click-area"
              aria-label="Flip flashcard"
              onClick={() => setFlipped(true)}
            >
              <CardVisual
                card={card}
                side={session.settings.direction === 'definition' ? 'answer' : 'question'}
                interactive={false}
              />
              <span>
                <RichText
                  text={session.settings.direction === 'definition' ? card.definition : card.term}
                />
              </span>
              <small>Click to flip</small>
            </button>
          </div>
          <div className="card-face back" aria-hidden={!flipped} inert={!flipped}>
            <span className="card-side-label">
              {session.settings.direction === 'definition' ? 'TERM' : 'DEFINITION'}
            </span>
            <button
              className="flip-click-area"
              aria-label="Flip flashcard back"
              onClick={() => setFlipped(false)}
            >
              <CardVisual
                card={card}
                side={session.settings.direction === 'definition' ? 'question' : 'answer'}
                interactive={false}
              />
              <span>
                <RichText
                  text={session.settings.direction === 'definition' ? card.term : card.definition}
                />
              </span>
              <small>Click to flip</small>
            </button>
          </div>
        </motion.div>
        <div className="card-tools">
          <button
            className="icon-button"
            aria-label="Read card aloud"
            onClick={() => {
              speechSynthesis.cancel();
              speechSynthesis.speak(new SpeechSynthesisUtterance(text));
            }}
          >
            <Volume2 size={20} />
          </button>
          <button
            className={`icon-button ${(star[card.id] ?? card.starred) ? 'starred' : ''}`}
            aria-label="Star card"
            onClick={async () => {
              const value = !(star[card.id] ?? card.starred);
              await patch(`/cards/${card.id}/star`, { starred: value });
              setStar({ ...star, [card.id]: value });
            }}
          >
            <Star size={20} fill={(star[card.id] ?? card.starred) ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      {sorting && (
        <div className="sort-actions">
          <button
            className="button still-learning"
            disabled={busy || !flipped}
            onClick={() => void move(1, false)}
          >
            <X size={20} />
            Still learning<kbd>1</kbd>
          </button>
          <button
            className="button know"
            disabled={busy || !flipped}
            onClick={() => void move(1, true)}
          >
            <Check size={21} />
            Know<kbd>2</kbd>
          </button>
        </div>
      )}
      <div className="flash-controls">
        <div className="row">
          <button
            className="icon-button"
            aria-label={autoplay ? 'Pause autoplay' : 'Autoplay'}
            onClick={() => setAutoplay(!autoplay)}
          >
            {autoplay ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button
            className="icon-button"
            aria-label="Keyboard shortcuts"
            onClick={() => setShowHelp(true)}
          >
            <Keyboard size={21} />
          </button>
        </div>
        <div className="row">
          <button
            className="icon-button bordered"
            aria-label="Previous card"
            disabled={index === 0 || busy}
            onClick={() => void move(-1)}
          >
            <ArrowLeft size={20} />
          </button>
          <span>
            {index + 1} / {session.cards.length}
          </span>
          <button
            className="icon-button bordered"
            aria-label="Next card"
            disabled={busy}
            onClick={() => void move(1)}
          >
            <ArrowRight size={20} />
          </button>
        </div>
        <Link className="text-button" to={`/sets/${session.setId}`}>
          View set
        </Link>
      </div>
      <div className="progress-track">
        <div style={{ width: `${(index / session.cards.length) * 100}%` }} />
      </div>
      <p className="study-tip">
        {sorting
          ? 'Try recalling the answer before you flip. “Know” is your self-rating, kept separate from quiz results.'
          : 'Try recalling the answer before you flip. Use the arrows to move through the set.'}
      </p>
      <Modal open={showHelp} onOpenChange={setShowHelp} title="Keyboard shortcuts">
        <div className="shortcut-row">
          <span>Flip card</span>
          <kbd>Space</kbd>
        </div>
        <div className="shortcut-row">
          <span>Previous / next card</span>
          <kbd>← / →</kbd>
        </div>
        {sorting && (
          <div className="shortcut-row">
            <span>Still learning / know</span>
            <kbd>1 / 2</kbd>
          </div>
        )}
      </Modal>
    </div>
  );
}
const CHECKPOINT_EVERY = 10;
const checkpointCopy = ['Great work.', 'Nice progress.', 'You’re on a roll.', 'Keep it up.'];
function Learn({
  session,
  save,
}: {
  session: Session;
  save: (s: any, complete?: boolean) => Promise<void>;
}) {
  const state = session.state,
    queue: string[] = state.queue || session.cards.map((c) => c.id),
    index = state.index || 0,
    card = session.cards.find((c) => c.id === queue[index])!;
  const [selected, setSelected] = useState<string | null>(null),
    [feedback, setFeedback] = useState<any>(null),
    [written, setWritten] = useState(''),
    [picks, setPicks] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false);
  const since = useRef(Date.now());
  const done = state.done || [];
  const checkpoint = state.checkpoint;
  const kind = card.answerKind || 'mcq';
  const isWritten = kind === 'written';
  const isTrueFalse = kind === 'tf';
  const isMatch = kind === 'match' && Boolean(card.match);
  const totalTerms = session.cards.reduce((n, c) => n + (c.match?.coveredIds.length ?? 1), 0);
  const options = isTrueFalse
    ? card.options
    : seededShuffle(card.options, `${session.id}:${card.id}:${state.answersCount || 0}`);
  async function answer(value: string) {
    if (feedback || busy) return;
    setBusy(true);
    try {
      const result = await attempt(
        session,
        card,
        isWritten ? 'written' : 'mcq',
        value,
        Date.now() - since.current,
      );
      setSelected(value);
      setFeedback(result);
      await save({ ...state, feedback: result, selected: value });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function answerMatch() {
    if (feedback || busy || !card.match) return;
    const pairs = card.match.items.map((item) => ({
      item,
      choice: card.match!.choices.find((choice) => choice.label === picks[item.cardId])!,
    }));
    if (pairs.some((pair) => !pair.choice)) {
      toast.error('Choose an option for every item first.');
      return;
    }
    setBusy(true);
    try {
      const elapsed = Math.max(
        1,
        Math.round((Date.now() - since.current) / card.match.items.length),
      );
      const results = await Promise.all(
        pairs.map(({ item, choice }) =>
          attempt(session, card, 'match', choice.text, elapsed, {}, item.cardId),
        ),
      );
      const match = pairs.map(({ item, choice }, i) => ({
        cardId: item.cardId,
        selected: choice.label,
        answer: item.answer,
        correct: (results[i] as any)?.correct === true,
      }));
      const result = { correct: match.every((entry) => entry.correct), match };
      setFeedback(result);
      await save({ ...state, feedback: result, selected: null });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (state.feedback) {
      setFeedback(state.feedback);
      setSelected(state.selected);
    } else {
      setFeedback(null);
      setSelected(null);
      setWritten('');
    }
    setPicks({});
  }, [index]);
  async function next() {
    if (busy || !feedback) return;
    setBusy(true);
    try {
      const q = [...queue];
      let nextDone = [...done];
      if (feedback.correct)
        nextDone = [...new Set([...done, ...(card.match?.coveredIds ?? [card.id])])];
      else q.splice(Math.min(index + 4, q.length), 0, card.id);
      const complete = index + 1 >= q.length;
      const answered = card.match ? card.match.items.length : 1;
      const correctItems = card.match
        ? feedback.match.filter((entry: any) => entry.correct).length
        : Number(feedback.correct);
      const answersCount = (state.answersCount || 0) + answered;
      const correctCount = (state.correctCount || 0) + correctItems;
      const checkpointDue =
        !complete &&
        Math.floor(answersCount / CHECKPOINT_EVERY) >
          Math.floor((state.answersCount || 0) / CHECKPOINT_EVERY);
      await save(
        {
          ...state,
          index: complete ? index : index + 1,
          queue: q,
          done: nextDone,
          feedback: null,
          selected: null,
          checkpoint: checkpointDue ? { answers: answersCount, correct: correctCount } : null,
          answersCount,
          correctCount,
        },
        complete,
      );
      setSelected(null);
      setFeedback(null);
      setWritten('');
      setPicks({});
      since.current = Date.now();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function dismissCheckpoint() {
    if (busy) return;
    setBusy(true);
    try {
      await save({ ...state, checkpoint: null });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (checkpoint) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (feedback && e.key === 'Enter') {
        e.preventDefault();
        void next();
      } else if (!feedback && !isWritten && !isMatch && ['1', '2', '3', '4'].includes(e.key)) {
        const choice = options[Number(e.key) - 1];
        if (choice) void answer(choice);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return (
    <div className="learn-stage">
      <div className="learn-top">
        <span>ROUND IN PROGRESS</span>
        <strong>
          {done.length} / {totalTerms} learned this round
        </strong>
      </div>
      <div className="progress-track">
        <div style={{ width: `${(done.length / totalTerms) * 100}%` }} />
      </div>
      {checkpoint ? (
        <motion.section
          className="checkpoint-panel"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <div className="checkpoint-symbol">
            <CheckCircle2 size={40} />
          </div>
          <span className="eyebrow">CHECKPOINT</span>
          <h1>
            {
              checkpointCopy[
                (Math.floor(checkpoint.answers / CHECKPOINT_EVERY) - 1) % checkpointCopy.length
              ]
            }
          </h1>
          <p>
            {checkpoint.correct} of {checkpoint.answers} correct so far · {done.length} of{' '}
            {totalTerms} terms learned this round.
          </p>
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void dismissCheckpoint()}
          >
            Keep going
            <ArrowRight size={18} />
          </button>
        </motion.section>
      ) : (
        <section className="question-panel">
          <div className="question-meta">
            <span>
              {isWritten
                ? 'Written question'
                : isTrueFalse
                  ? 'True or false'
                  : isMatch
                    ? 'Matching'
                    : 'Multiple choice'}
            </span>
            <span>{card.topic}</span>
          </div>
          <CardVisual card={card} side="question" />
          {isMatch ? (
            <div className="learn-match">
              <p className="match-direction">
                <RichText text={card.match!.stem} />
              </p>
              <div className="match-grid" role="group" aria-label="Matching items and options">
                {Array.from({
                  length: Math.max(card.match!.items.length, card.match!.choices.length),
                }).map((_, i) => {
                  const item = card.match!.items[i];
                  const choice = card.match!.choices[i];
                  const result = item
                    ? feedback?.match?.find((entry: any) => entry.cardId === item.cardId)
                    : undefined;
                  const picked = item ? picks[item.cardId] || result?.selected || '' : '';
                  const correct = choice
                    ? feedback?.match?.some((entry: any) => entry.answer === choice.label)
                    : false;
                  const selectedEntry = choice
                    ? feedback?.match?.find((entry: any) => entry.selected === choice.label)
                    : undefined;
                  const wrong = Boolean(selectedEntry && !selectedEntry.correct && !correct);
                  const chosen = Boolean(
                    choice &&
                    (Object.values(picks).includes(choice.label) ||
                      feedback?.match?.some((entry: any) => entry.selected === choice.label)),
                  );
                  return (
                    <div className="match-row" key={i}>
                      {item ? (
                        <div
                          className={`match-item ${result ? (result.correct ? 'correct' : 'incorrect') : ''}`}
                        >
                          <span className="match-marker">
                            {result ? (
                              result.correct ? (
                                <Check size={15} />
                              ) : (
                                <X size={15} />
                              )
                            ) : (
                              i + 1
                            )}
                          </span>
                          <span className="match-item-text">
                            <RichText text={item.text} />
                          </span>
                          <span className={`match-select ${picked ? 'filled' : ''}`}>
                            <select
                              aria-label={`Option for item ${i + 1}`}
                              value={picked}
                              disabled={Boolean(feedback) || busy}
                              onChange={(e) =>
                                setPicks({ ...picks, [item.cardId]: e.target.value })
                              }
                            >
                              <option value="">—</option>
                              {card.match!.choices.map((option) => (
                                <option key={option.label} value={option.label}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </span>
                          {result && !result.correct && (
                            <small className="match-correction">
                              Correct: <b>{result.answer}</b>
                            </small>
                          )}
                        </div>
                      ) : (
                        <div className="match-item empty" aria-hidden="true" />
                      )}
                      {choice ? (
                        <div
                          className={`match-option ${correct ? 'correct' : ''} ${
                            wrong ? 'incorrect' : ''
                          } ${chosen && !correct && !wrong ? 'chosen' : ''}`}
                        >
                          <span className="match-marker">{choice.label}</span>
                          <span className="match-option-text">
                            <RichText text={choice.text} />
                          </span>
                        </div>
                      ) : (
                        <div className="match-option empty" aria-hidden="true" />
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="match-note">
                An option may be used once, more than once, or not at all.
              </p>
              {!feedback && (
                <button
                  className="button primary"
                  disabled={busy || card.match!.items.some((item) => !picks[item.cardId])}
                  onClick={() => void answerMatch()}
                >
                  Check answers
                  <ArrowRight size={18} />
                </button>
              )}
            </div>
          ) : (
            <>
              <h2>
                <RichText text={promptOf(card)} />
              </h2>
              {isTrueFalse && card.pair && (
                <p className="tf-pair">
                  “<RichText text={card.pair} />”
                </p>
              )}
              {isWritten ? (
                <form
                  className="written-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void answer(written);
                  }}
                >
                  <label className="sr-only" htmlFor="written-answer">
                    Your answer
                  </label>
                  <input
                    id="written-answer"
                    autoFocus
                    placeholder="Type your answer"
                    value={written}
                    disabled={Boolean(feedback) || busy}
                    onChange={(e) => setWritten(e.target.value)}
                  />
                  {!feedback && (
                    <button className="button primary" disabled={!written.trim() || busy}>
                      Check answer
                      <ArrowRight size={18} />
                    </button>
                  )}
                </form>
              ) : (
                <>
                  <p className="choice-instruction">
                    {isTrueFalse ? 'Is this pairing correct?' : 'Choose the correct answer'}
                  </p>
                  <div className="answer-options">
                    {options.map((o, i) => (
                      <button
                        key={o}
                        className={`answer-option ${feedback ? (o === answerOf(card) ? 'correct' : o === selected ? 'incorrect' : 'faded') : ''}`}
                        disabled={Boolean(feedback) || busy}
                        onClick={() => void answer(o)}
                      >
                        <span className="option-number">
                          {feedback && o === answerOf(card) ? (
                            <Check size={17} />
                          ) : feedback && o === selected ? (
                            <X size={17} />
                          ) : (
                            i + 1
                          )}
                        </span>
                        <span>
                          <RichText text={o} />
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
          {feedback && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`answer-feedback ${feedback.correct ? 'positive' : 'negative'}`}
            >
              <div className="row">
                <span>
                  {feedback.correct ? <CheckCircle2 size={22} /> : <RotateCcw size={22} />}
                </span>
                <h3>
                  {isMatch
                    ? feedback.correct
                      ? 'You matched them all.'
                      : 'A few pairs still need work.'
                    : feedback.correct
                      ? 'You got it.'
                      : 'You’re still learning this one.'}
                </h3>
              </div>
              {isMatch
                ? !feedback.correct && (
                    <p>
                      <strong>Keep going</strong>
                      <br />
                      The letters marked in red are corrected next to each item. Missed items return
                      later in this round.
                    </p>
                  )
                : !feedback.correct && (
                    <p>
                      <strong>Correct answer</strong>
                      <br />
                      {answerOf(card)}
                    </p>
                  )}
              {!isMatch && isWritten && !feedback.correct && (
                <small>
                  Written grading matches the answer or its saved aliases. Add an accepted
                  equivalent in the set editor if needed.
                </small>
              )}
              {!isMatch && <CardVisual card={card} side="answer" />}
              {!isMatch && card.explanation && (
                <p>
                  <RichText text={card.explanation} />
                </p>
              )}
              {!isMatch && <SourceLinks card={card} />}
              <button className="button primary" disabled={busy} onClick={() => void next()}>
                Continue
                <ArrowRight size={18} />
                <kbd>↵</kbd>
              </button>
            </motion.div>
          )}
        </section>
      )}
      <p className="study-tip">
        {isWritten
          ? 'Recall the whole idea, including any essential conditions.'
          : isTrueFalse
            ? 'Decide whether the pairing is correct. Keys 1 and 2 work too.'
            : isMatch
              ? 'Give every item a letter, then check your answers.'
              : 'Use keys 1–4 to answer and Enter to continue.'}
      </p>
    </div>
  );
}
function Match({
  session,
  save,
}: {
  session: Session;
  save: (s: any, complete?: boolean) => Promise<void>;
}) {
  const state = session.state;
  const [tiles] = useState(
    () =>
      state.tiles ||
      shuffle(
        session.cards.flatMap((c) => [
          { id: c.id + '-term', cardId: c.id, side: 'term', text: c.term },
          { id: c.id + '-definition', cardId: c.id, side: 'definition', text: c.definition },
        ]),
      ),
  );
  const [selected, setSelected] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [bad, setBad] = useState<string[]>([]),
    [elapsed, setElapsed] = useState(state.elapsed || 0);
  const mounted = useRef(Date.now()),
    base = useRef(state.elapsed || 0);
  const matched: string[] = state.matched || [];
  const [penalty, setPenalty] = useState(state.penalty || 0);
  useEffect(() => {
    const timer = setInterval(
      () => setElapsed(base.current + (Date.now() - mounted.current) / 1000),
      100,
    );
    return () => clearInterval(timer);
  }, []);
  async function choose(tile: any) {
    if (busy || matched.includes(tile.cardId) || selected?.id === tile.id) return;
    if (!selected || selected.side === tile.side) {
      setSelected(tile);
      return;
    }
    setBusy(true);
    const correct = tile.cardId === selected.cardId;
    const term = tile.side === 'term' ? tile : selected;
    const definition = tile.side === 'definition' ? tile : selected;
    const card = session.cards.find((c) => c.id === term.cardId)!;
    try {
      await attempt(
        session,
        card,
        'match',
        definition.text,
        Math.max(0, (elapsed - (state.elapsed || 0)) * 1000),
        { matchedCardId: definition.cardId },
      );
      const newMatched = correct ? [...matched, tile.cardId] : matched;
      const newPenalty = penalty + (correct ? 0 : 2);
      if (!correct) {
        setBad([tile.id, selected.id]);
        setPenalty(newPenalty);
      }
      await save(
        {
          ...state,
          tiles,
          matched: newMatched,
          elapsed,
          penalty: newPenalty,
          totalTime: elapsed + newPenalty,
        },
        newMatched.length === session.cards.length,
      );
      if (!correct) await new Promise((r) => setTimeout(r, 450));
      setSelected(null);
      setBad([]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="match-stage">
      <div className="match-top">
        <div>
          <span className="eyebrow">MATCH THE PAIRS</span>
          <h1>Make every connection.</h1>
        </div>
        <div className="match-timer">
          <Clock3 size={22} />
          <strong>{(elapsed + penalty).toFixed(1)}</strong>
          <span>seconds</span>
        </div>
      </div>
      <div className="match-board">
        {tiles.map((t: any) => (
          <motion.button
            layout
            key={t.id}
            disabled={matched.includes(t.cardId) || busy}
            animate={{
              opacity: matched.includes(t.cardId) ? 0 : 1,
              scale: matched.includes(t.cardId) ? 0.92 : 1,
            }}
            className={`match-tile ${selected?.id === t.id ? 'selected' : ''} ${bad.includes(t.id) ? 'mismatch' : ''} ${matched.includes(t.cardId) ? 'matched' : ''}`}
            aria-label={`${t.side}: ${t.text}`}
            onClick={() => void choose(t)}
          >
            {t.side === 'term' &&
              (session.cards.find((c) => c.id === t.cardId) as any)?.image?.matchUsable && (
                <CardVisual
                  card={session.cards.find((c) => c.id === t.cardId)!}
                  side="question"
                  interactive={false}
                />
              )}
            <RichText text={t.text} />
          </motion.button>
        ))}
      </div>
      <div className="row between">
        <span className="muted">
          {matched.length} of {session.cards.length} pairs matched
        </span>
        <span className="muted">
          {penalty ? `${penalty}s in mismatch penalties` : 'Select a term, then its definition.'}
        </span>
      </div>
      <p className="study-tip">
        Match measures recognition. Follow it with Learn to practice recall.
      </p>
    </div>
  );
}
function Test({ session, onUpdate }: { session: Session; onUpdate: (s: Session) => void }) {
  const { refresh } = useApp();
  const [answers, setAnswers] = useState<Record<string, string>>(session.state.answers || {}),
    [result, setResult] = useState<any>(session.result || null),
    [busy, setBusy] = useState(false),
    [saveStatus, setSaveStatus] = useState('Saved');
  const [saveError, setSaveError] = useState(false);
  const since = useRef(Date.now()),
    pendingSave = useRef<Promise<any>>(Promise.resolve());
  const durationBase = session.state.durationMs || 0;
  const answered = session.cards.filter((c) => (answers[c.id] || '').trim()).length;
  function select(cardId: string, value: string) {
    const next = { ...answers, [cardId]: value };
    setAnswers(next);
    setSaveStatus('Saving…');
    setSaveError(false);
    pendingSave.current = pendingSave.current
      .catch(() => {})
      .then(() =>
        patch(`/sessions/${session.id}`, {
          state: { answers: next, durationMs: durationBase + Date.now() - since.current },
        }),
      )
      .then(() => setSaveStatus('Saved'))
      .catch((e) => {
        setSaveStatus('Not saved. Select your answer again to retry.');
        setSaveError(true);
        toast.error(e.message);
      });
  }
  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await pendingSave.current;
      const r = await post(`/sessions/${session.id}/submit`, {
        answers,
        durationMs: durationBase + Date.now() - since.current,
      });
      setResult(r);
      await refresh();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (result)
    return (
      <div className="test-stage">
        <div className="test-result-hero">
          <div
            className="score-ring"
            style={{ '--score': `${(result.correct / result.total) * 360}deg` } as any}
          >
            <span>
              {Math.round((result.correct / result.total) * 100)}
              <small>%</small>
            </span>
          </div>
          <div>
            <span className="eyebrow">TEST COMPLETE</span>
            <h1>
              {result.correct === result.total
                ? 'Look at what you know.'
                : 'A clearer picture of what’s next.'}
            </h1>
            <p>
              {result.correct} correct out of {result.total} questions. Review your answers below.
            </p>
            <Link to={`/sets/${session.setId}/learn`} className="button primary">
              Practice in Learn
              <ArrowRight size={18} />
            </Link>
          </div>
        </div>
        <div className="section-title">
          <h2>Your answers</h2>
          <button className="text-button" onClick={() => window.print()}>
            <FileText size={16} />
            Print results
          </button>
        </div>
        {result.questions.map((q: any, i: number) => (
          <div className={`test-review panel ${q.correct ? 'right' : 'wrong'}`} key={q.cardId}>
            <div className="row between">
              <span className="eyebrow">QUESTION {i + 1}</span>
              <span className={`row ${q.correct ? 'success-text' : 'error-text'}`}>
                {q.correct ? <Check size={18} /> : <X size={18} />}{' '}
                {q.correct ? 'Correct' : 'Incorrect'}
              </span>
            </div>
            <CardVisual card={session.cards.find((c) => c.id === q.cardId)!} side="question" />
            <h3>
              <RichText text={q.term} />
            </h3>
            <p className={!q.correct ? 'error-text' : ''}>Your answer: {q.response}</p>
            {!q.correct && <p className="success-text">Correct answer: {q.answer}</p>}
            {q.explanation && (
              <p>
                <RichText text={q.explanation} />
              </p>
            )}
            <CardVisual card={session.cards.find((c) => c.id === q.cardId)!} side="answer" />
            <SourceLinks card={session.cards.find((c) => c.id === q.cardId)!} />
          </div>
        ))}
        <Link to={`/sets/${session.setId}`} className="button secondary">
          Return to set
        </Link>
      </div>
    );
  return (
    <div className="test-stage">
      <div className="page-title row between">
        <div>
          <span className="eyebrow">PRACTICE TEST</span>
          <h1>Take your time. You’ve got this.</h1>
          <p>{session.cards.length} questions · answer at your own pace</p>
        </div>
        <div className="test-count">
          <strong>
            {answered} / {session.cards.length}
          </strong>
          <small className={saveError ? 'error-text' : ''}>{saveStatus}</small>
        </div>
      </div>
      {session.cards.map((c, i) => {
        const isWritten = c.answerKind === 'written';
        return (
          <section className="test-question panel" key={c.id}>
            <div className="question-meta">
              <span>
                Question {i + 1} of {session.cards.length}
              </span>
              <span>{c.topic}</span>
            </div>
            <CardVisual card={c} side="question" />
            <h2>
              <RichText text={promptOf(c)} />
            </h2>
            {c.answerKind === 'tf' && c.pair && (
              <p className="tf-pair">
                “<RichText text={c.pair} />”
              </p>
            )}
            {isWritten ? (
              <input
                className="test-written"
                aria-label={`Answer for question ${i + 1}`}
                placeholder="Type your answer"
                value={answers[c.id] || ''}
                onChange={(e) => setAnswers({ ...answers, [c.id]: e.target.value })}
                onBlur={(e) => select(c.id, e.target.value)}
              />
            ) : (
              <div className="answer-options" role="radiogroup" aria-label={`Question ${i + 1}`}>
                {c.options.map((o) => (
                  <button
                    role="radio"
                    aria-checked={answers[c.id] === o}
                    key={o}
                    className={`answer-option ${answers[c.id] === o ? 'selected' : ''}`}
                    onClick={() => select(c.id, o)}
                  >
                    <span className="radio-circle">{answers[c.id] === o && <span />}</span>
                    <span>
                      <RichText text={o} />
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
      <div className="test-submit">
        <p>
          {answered === session.cards.length
            ? 'All questions answered. Ready when you are.'
            : `${session.cards.length - answered} questions left to answer`}
        </p>
        <button
          className="button primary"
          disabled={answered !== session.cards.length || busy}
          onClick={() => void submit()}
        >
          {busy ? <LoaderCircle className="spin" size={18} /> : <Check size={19} />}Submit test
        </button>
      </div>
    </div>
  );
}
function SessionResult({
  session,
  onRestart,
  onKeepStudying,
  onReviewMissed,
}: {
  session: Session;
  onRestart: () => void;
  onKeepStudying: () => void;
  onReviewMissed: () => void;
}) {
  const { state } = session;
  const answersCount = state.answersCount || 0;
  const correctCount = state.correctCount || 0;
  const perfect = answersCount > 0 && correctCount === answersCount;
  return (
    <div className="session-result">
      <div className="result-symbol">
        <Check size={50} />
      </div>
      <span className="eyebrow">
        {session.mode === 'learn' ? 'ROUND COMPLETE' : 'SESSION COMPLETE'}
      </span>
      <h1>
        {session.mode === 'match'
          ? 'You made every connection.'
          : session.mode === 'learn'
            ? perfect
              ? 'Perfect round. Every answer correct.'
              : 'Great work — you finished the round.'
            : 'A little more learned.'}
      </h1>
      <p>
        {session.mode === 'match'
          ? `You matched ${session.cards.length} pairs in ${Number(state.totalTime || 0).toFixed(1)} seconds.`
          : session.mode === 'flashcards'
            ? `You reviewed ${session.cards.length} cards. ${Object.values(state.ratings || {}).filter(Boolean).length} marked “Know”.`
            : `You answered ${answersCount} questions with ${correctCount} correct, and every term in the round came back around. Keep going to move this set into long-term memory.`}
      </p>
      {session.mode === 'match' && (
        <p className="personal-best">
          {session.bestTime
            ? state.totalTime < session.bestTime
              ? `New personal best. Previous best: ${session.bestTime.toFixed(1)} seconds.`
              : `Personal best: ${session.bestTime.toFixed(1)} seconds.`
            : 'Your first recorded time for this set.'}
        </p>
      )}
      <div className="result-actions">
        {session.mode === 'flashcards' &&
          Object.values(state.ratings || {}).some((v) => v === false) && (
            <button className="button primary" onClick={onReviewMissed}>
              Review still learning
              <ArrowRight size={17} />
            </button>
          )}
        {session.mode === 'learn' ? (
          <button className="button primary" onClick={onKeepStudying}>
            Keep studying
            <ArrowRight size={18} />
          </button>
        ) : (
          <button className="button primary" onClick={onRestart}>
            <RotateCcw size={18} />
            Study again
          </button>
        )}
        <Link to={`/sets/${session.setId}`} className="button secondary">
          Back to set
        </Link>
      </div>
      <Link to="/insights" className="text-button">
        Talk through my progress
        <ArrowUpRight size={17} />
      </Link>
    </div>
  );
}

function SourceLinks({ card }: { card: Card }) {
  if (!card?.sources?.length) return null;
  return (
    <details className="source-links">
      <summary>Check the source</summary>
      {card.sources.map((s, i) => (
        <a
          key={i}
          href={s.assetId ? `/api/assets/${s.assetId}` : `/api/sources/${s.sourceId}/text`}
          target="_blank"
          rel="noreferrer"
        >
          {s.locator} · {s.quote}
        </a>
      ))}
    </details>
  );
}
