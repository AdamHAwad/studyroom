import { useState, useEffect, useRef, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Plus,
  BookOpen,
  Layers,
  ArrowRight,
  ChevronRight,
  ArrowLeft,
  ArrowUp,
  UploadCloud,
  FileText,
  X,
  Check,
  LoaderCircle,
  Sparkles,
  Star,
  Pencil,
  Trash2,
  Download,
  Archive,
  RotateCcw,
  MessageCircle,
  ChartNoAxesCombined,
  Clock3,
  Target,
  Settings,
  ExternalLink,
  Send,
  Square,
  FolderOpen,
  CheckCircle2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { useApp } from './App';
import { DocumentTile } from './Documents';
import { api, post, patch } from './api';
import { Modal, Empty, SetTile, JobList, Loading, AgentPill, CourseModal } from './ui';
import { AgentSettings } from './components/AgentSettings';
import type { Card, StudySet, Source, Conversation, ChatMessage, Job } from './types';
import CardVisual from './components/CardVisual';
import { modes } from './study-modes';
import RichText from './RichText';

export function CoursePage() {
  const { courseId } = useParams();
  const { data, refresh } = useApp();
  const course = data.courses.find((c) => c.id === courseId);
  const [archive, setArchive] = useState(false),
    [editCourse, setEditCourse] = useState(false);
  const navigate = useNavigate();
  if (!course)
    return (
      <Empty
        title="Course not found"
        description="Check your library or restore it from Settings."
      />
    );
  const sets = data.sets.filter((s) => s.courseId === course.id);
  const documents = (data.documents || []).filter((d) => d.courseId === course.id);
  return (
    <div className="page">
      <Link className="breadcrumb" to="/library">
        Your library
        <ChevronRight size={14} />
        Courses
      </Link>
      <div className="page-title row between">
        <div className="row">
          <div className={`course-heading-icon ${course.color}`}>
            <BookOpen size={30} />
          </div>
          <div>
            <span className="eyebrow">{course.code || 'YOUR COURSE'}</span>
            <h1>{course.name}</h1>
            <p>
              {sets.length} study sets · {sets.reduce((a, s) => a + (s.cardCount || 0), 0)} terms
            </p>
          </div>
        </div>
        <button
          className="icon-button"
          aria-label="Edit course"
          onClick={() => setEditCourse(true)}
        >
          <Pencil size={19} />
        </button>
        <button
          className="icon-button"
          aria-label="Archive course"
          onClick={() => setArchive(true)}
        >
          <Archive size={20} />
        </button>
      </div>
      <div className="course-actions">
        <Link to={`/courses/${course.id}/create`} className="button primary">
          <Plus size={19} />
          Create new
        </Link>
        <Link to={`/insights?course=${course.id}`} className="button secondary">
          <Sparkles size={18} />
          Ask about this course
        </Link>
      </div>
      <JobList
        jobs={data.jobs
          .filter(
            (j) =>
              j.courseId === course.id &&
              ['set', 'practice-exam', 'retrieval-packet'].includes(j.kind) &&
              ['queued', 'running', 'failed', 'cancelled'].includes(j.status),
          )
          .slice(0, 4)}
        refresh={refresh}
      />
      <div className="section-title">
        <h2>Study materials</h2>
        <span className="muted">Most recent first</span>
      </div>
      {sets.length || documents.length ? (
        <div className="set-grid">
          {[
            ...sets.map((s) => ({ type: 'set', item: s })),
            ...documents.map((d) => ({ type: 'document', item: d })),
          ]
            .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt))
            .map(({ type, item }) =>
              type === 'set' ? (
                <SetTile key={item.id} set={item as StudySet} course={course} />
              ) : (
                <DocumentTile key={item.id} document={item as any} course={course} />
              ),
            )}
        </div>
      ) : (
        <Empty
          icon={<UploadCloud size={32} />}
          title="Bring your materials into this course"
          description="Upload your notes, slides, or readings together. Your study agent will build one cohesive set, with references back to the material."
        >
          <Link to={`/courses/${course.id}/create`} className="button primary">
            Create new
            <ArrowRight size={18} />
          </Link>
        </Empty>
      )}
      <CourseModal
        open={editCourse}
        onOpenChange={setEditCourse}
        course={course}
        refresh={refresh}
      />
      <Modal
        open={archive}
        onOpenChange={setArchive}
        title="Archive this course?"
        description="The course, sets, and progress stay saved. Restore them any time in Settings."
      >
        <div className="modal-footer">
          <button className="button secondary" onClick={() => setArchive(false)}>
            Keep course
          </button>
          <button
            className="button primary"
            onClick={async () => {
              await patch(`/courses/${course.id}`, { archived: true });
              await refresh();
              navigate('/library');
            }}
          >
            Archive course
          </button>
        </div>
      </Modal>
    </div>
  );
}
export function SetPage() {
  const { setId } = useParams();
  const { data, refresh } = useApp();
  const [set, setSet] = useState<StudySet | null>(null),
    [index, setIndex] = useState(0),
    [flipped, setFlipped] = useState(false),
    [archive, setArchive] = useState(false),
    [reviewBusy, setReviewBusy] = useState(false),
    [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    api<StudySet>(`/sets/${setId}`)
      .then(setSet)
      .catch((e) => setError(e.message));
  }, [setId]);
  if (error) return <Empty title="Set couldn't load" description={error} />;
  if (!set) return <Loading />;
  const course = data.courses.find((c) => c.id === set.courseId);
  const cards = set.cards || [];
  const card = cards[index];
  const progress = data.progress.filter((p) => cards.some((c) => c.id === p.cardId));
  const familiar = progress.filter(
    (p) => p.status === 'familiar' || p.status === 'retained',
  ).length;
  return (
    <div className="page set-page">
      <Link className="breadcrumb" to={`/courses/${set.courseId}`}>
        <BookOpen size={15} />
        {course?.name || 'Course'}
        <ChevronRight size={14} />
        Study set
      </Link>
      <div className="page-title">
        <h1>{set.title}</h1>
        <div className="row between">
          <p>
            {cards.length} terms ·{' '}
            {set.origin === 'lecture' ? 'Created from your materials' : 'Created by you'}
          </p>
          <div className="row">
            <Link className="icon-button" aria-label="Edit set" to={`/sets/${set.id}/edit`}>
              <Pencil size={19} />
            </Link>
            <button
              className="icon-button"
              aria-label="Archive set"
              onClick={() => setArchive(true)}
            >
              <Archive size={19} />
            </button>
          </div>
        </div>
      </div>
      <div className="mode-grid">
        {modes.map((m) => (
          <Link className={`mode-tile ${m.id}`} key={m.id} to={`/sets/${set.id}/${m.id}`}>
            <m.icon size={25} />
            <strong>{m.name}</strong>
            <ChevronRight size={18} />
          </Link>
        ))}
      </div>
      {card && (
        <>
          <button
            className={`preview-card ${flipped ? 'is-flipped' : ''}`}
            onClick={() => setFlipped(!flipped)}
          >
            <span className="card-side-label">{flipped ? 'DEFINITION' : 'TERM'}</span>
            <CardVisual card={card} side={flipped ? 'answer' : 'question'} interactive={false} />
            <span className="preview-text">
              <RichText text={flipped ? card.definition : card.term} />
            </span>
            <span className="flip-hint">Click to flip</span>
          </button>
          <div className="preview-controls">
            <button
              className="icon-button bordered"
              aria-label="Previous card"
              disabled={index === 0}
              onClick={() => {
                setIndex(index - 1);
                setFlipped(false);
              }}
            >
              <ArrowLeft size={20} />
            </button>
            <span>
              {index + 1} / {cards.length}
            </span>
            <button
              className="icon-button bordered"
              aria-label="Next card"
              disabled={index === cards.length - 1}
              onClick={() => {
                setIndex(index + 1);
                setFlipped(false);
              }}
            >
              <ArrowRight size={20} />
            </button>
          </div>
        </>
      )}
      <div className="set-summary">
        <div>
          <h3>Your progress</h3>
          <p>
            {familiar} of {cards.length} terms answered correctly in practice
          </p>
          <div className="progress-track">
            <div style={{ width: `${cards.length ? (familiar / cards.length) * 100 : 0}%` }} />
          </div>
        </div>
        <Link to={`/sets/${set.id}/learn`} className="button secondary">
          Keep learning
          <ArrowRight size={17} />
        </Link>
      </div>
      {set.description && <p className="set-description">{set.description}</p>}
      {(Boolean(set.warnings?.length) ||
        ['pending', 'optional'].includes(set.coverage?.qualityReview)) && (
        <details className="notice">
          <summary>
            {set.warnings.length
              ? `Source and coverage notes · ${set.warnings.length}`
              : 'Optional quality review'}
          </summary>
          {set.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          {['pending', 'optional'].includes(set.coverage?.qualityReview) && (
            <button
              className="button secondary small"
              disabled={reviewBusy}
              onClick={async () => {
                setReviewBusy(true);
                try {
                  await post(`/sets/${set.id}/review`, {});
                  toast.success('Quality review queued');
                  await refresh();
                  const latest = await api<StudySet>(`/sets/${set.id}`);
                  setSet(latest);
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setReviewBusy(false);
                }
              }}
            >
              {reviewBusy ? 'Queueing review…' : 'Run quality review'}
            </button>
          )}
        </details>
      )}
      <div className="section-title">
        <h2>
          Terms in this set <span className="muted">{cards.length}</span>
        </h2>
        <Link className="text-button" to={`/sets/${set.id}/edit`}>
          <Pencil size={16} />
          Edit terms
        </Link>
      </div>
      <div className="term-list">
        {cards.map((c, i) => (
          <div className="term-row" key={c.id}>
            <div className="term-number">{i + 1}</div>
            <div className="term-cue">
              <RichText text={c.term} />
            </div>
            <div className="term-answer">
              <RichText text={c.definition} />
              <CardVisual card={c} side="question" />
              <CardVisual card={c} side="answer" />
              {c.sources.length > 0 && (
                <details>
                  <summary>
                    {c.sources.length} source reference{c.sources.length > 1 ? 's' : ''}
                  </summary>
                  {c.sources.map((s, k) => (
                    <p key={k}>
                      <a
                        href={
                          s.assetId ? `/api/assets/${s.assetId}` : `/api/sources/${s.sourceId}/text`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {s.locator}
                      </a>{' '}
                      · {s.quote}
                    </p>
                  ))}
                </details>
              )}
            </div>
            <button
              className={`icon-button ${c.starred ? 'starred' : ''}`}
              aria-label={c.starred ? 'Unstar term' : 'Star term'}
              onClick={async () => {
                await patch(`/cards/${c.id}/star`, { starred: !c.starred });
                setSet({
                  ...set,
                  cards: cards.map((x) => (x.id === c.id ? { ...x, starred: !x.starred } : x)),
                });
              }}
            >
              <Star size={19} fill={c.starred ? 'currentColor' : 'none'} />
            </button>
          </div>
        ))}
      </div>
      <Modal
        open={archive}
        onOpenChange={setArchive}
        title="Archive this set?"
        description="Your cards and progress stay saved. Restore the set from Settings."
      >
        <div className="modal-footer">
          <button className="button secondary" onClick={() => setArchive(false)}>
            Keep set
          </button>
          <button
            className="button primary"
            onClick={async () => {
              await patch(`/sets/${set.id}`, { archived: true });
              await refresh();
              navigate(`/courses/${set.courseId}`);
            }}
          >
            Archive set
          </button>
        </div>
      </Modal>
    </div>
  );
}
const blankCard = () => ({
  term: '',
  definition: '',
  question: '',
  distractors: [] as string[],
  explanation: '',
  topic: 'General',
  aliases: [] as string[],
  sources: [],
});
const creationTypes = [
  {
    kind: 'set',
    title: 'Study Set',
    description: 'Turn your materials into flashcards, Learn, Match, and Test.',
    icon: Layers,
  },
  {
    kind: 'practice-exam',
    title: 'Practice Exam',
    description: "New questions in the style of your professor's sample exams.",
    icon: FileText,
  },
  {
    kind: 'retrieval-packet',
    title: 'Retrieval Packet',
    description: 'A printable guide with room to recall, define, and make connections.',
    icon: Pencil,
  },
];
export function CreateSet() {
  const [params] = useSearchParams();
  const { courseId } = useParams();
  const selected = creationTypes.find((t) => t.kind === params.get('kind'));
  if (selected)
    return <CreateSetForm key={(courseId || 'new') + selected.kind} kind={selected.kind} />;
  return (
    <div className="page editor-page">
      <div className="page-title">
        <h1>What would you like to create?</h1>
        <p>Start with your course materials. Choose how you want to practice.</p>
      </div>
      <div className="create-options">
        {creationTypes.map(({ kind, title, description, icon: Icon }) => (
          <Link key={kind} to={`?kind=${kind}`} className="create-option">
            <span className="create-option-icon">
              <Icon size={28} />
            </span>
            <div>
              <h2>{title}</h2>
              <p>{description}</p>
            </div>
            <ArrowRight size={22} />
          </Link>
        ))}
      </div>
    </div>
  );
}
function CreateSetForm({ kind }: { kind: string }) {
  const { courseId } = useParams();
  const { data, refresh, newCourse } = useApp();
  const navigate = useNavigate();
  const draftKey = 'studyroom:draft:' + (courseId || 'new') + (kind === 'set' ? '' : ':' + kind);
  const isSet = kind === 'set';
  const isExam = kind === 'practice-exam';
  const label = isSet ? 'study set' : isExam ? 'practice exam' : 'retrieval packet';
  const [draft] = useState<any>(() => {
    try {
      return JSON.parse(localStorage.getItem(draftKey) || '{}');
    } catch {
      return {};
    }
  });
  const [previousSources, setPreviousSources] = useState<Source[]>([]);
  const [course, setCourse] = useState(draft.course || courseId || data.courses[0]?.id || ''),
    [title, setTitle] = useState(draft.title || ''),
    [instructions, setInstructions] = useState(draft.instructions || ''),
    [mode, setMode] = useState(isSet ? draft.mode || 'upload' : 'upload'),
    [referenceSourceIds, setReferenceSourceIds] = useState<string[]>(
      draft.referenceSourceIds || [],
    ),
    [files, setFiles] = useState<
      { key: string; name: string; status: string; source?: Source; error?: string }[]
    >(
      draft.files?.map((f: any) =>
        f.status === 'uploading'
          ? {
              ...f,
              status: 'failed',
              error:
                'This upload was interrupted. Remove it and upload again, or select it from previous uploads.',
            }
          : f,
      ) || [],
    ),
    [busy, setBusy] = useState(false),
    [drag, setDrag] = useState(false),
    [cards, setCards] = useState<any[]>(draft.cards || [blankCard(), blankCard()]);
  const input = useRef<HTMLInputElement>(null);
  const [importText, setImportText] = useState('');
  useEffect(() => {
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ course, title, instructions, mode, files, cards, referenceSourceIds }),
      );
    } catch {
      /* Browser storage may be unavailable; server-saved sets remain safe. */
    }
  }, [course, title, instructions, mode, files, cards, referenceSourceIds, draftKey]);
  useEffect(() => {
    api<Source[]>('/sources')
      .then((ss) =>
        setPreviousSources(ss.filter((s) => s.courseId === course && s.status === 'ready')),
      )
      .catch(() => {});
  }, [course]);
  async function uploadFiles(list: FileList | File[] | null) {
    if (!list || !course) return;
    const incoming = Array.from(list).map((file) => ({ file, key: crypto.randomUUID() }));
    setFiles((prev) => [
      ...prev,
      ...incoming.map((x) => ({ key: x.key, name: x.file.name, status: 'uploading' })),
    ]);
    for (const { file: f, key } of incoming) {
      const body = new FormData();
      body.append('file', f);
      try {
        const source = await api<Source>(`/courses/${course}/upload`, { method: 'POST', body });
        if (isExam && /exam|quiz|test/i.test(source.name))
          setReferenceSourceIds((prev) => [...new Set([...prev, source.id])]);
        setFiles((prev) =>
          prev.map((x) =>
            x.key === key
              ? { ...x, source, status: source.status, error: source.error || undefined }
              : x,
          ),
        );
      } catch (e) {
        setFiles((prev) =>
          prev.map((x) =>
            x.key === key ? { ...x, status: 'failed', error: (e as Error).message } : x,
          ),
        );
      }
    }
  }
  const pending = files.some((f) => f.status === 'uploading'),
    ready = files.filter((f) => f.status === 'ready');
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'upload') {
        await post('/jobs/set', {
          kind,
          referenceSourceIds: referenceSourceIds.filter((id) =>
            ready.some((f) => f.source?.id === id),
          ),
          courseId: course,
          title,
          instructions,
          sourceIds: ready.map((f) => f.source!.id),
        });
        await refresh();
        localStorage.removeItem(draftKey);
        navigate(`/courses/${course}`);
        toast.success(`Your ${label} is being created. You can keep using the app.`);
      } else {
        const s = await post('/sets', {
          courseId: course,
          title,
          description: instructions,
          cards,
        });
        await refresh();
        localStorage.removeItem(draftKey);
        navigate(`/sets/${s.id}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data.courses.length)
    return (
      <div className="page">
        <Empty
          icon={<BookOpen size={30} />}
          title="Start with a course"
          description="Your new sets will live inside a course. Add your first class to get started."
        >
          <button className="button primary" onClick={newCourse}>
            <Plus size={18} />
            Create a course
          </button>
        </Empty>
      </div>
    );
  return (
    <div className="page editor-page">
      <Link className="breadcrumb" to={course ? `/courses/${course}` : '/library'}>
        <ArrowLeft size={15} />
        Back to course
      </Link>
      <div className="page-title">
        <h1>Create a new {label}</h1>
        <p>
          {isSet
            ? "Bring the material. We'll help you make it stick."
            : isExam
              ? 'Upload sample exams and course materials for fresh questions with a familiar format.'
              : 'Turn your materials into a printable guide with space to write and remember.'}
        </p>
        <Link className="text-button" to="?">
          Change type
        </Link>
      </div>
      <form onSubmit={submit}>
        <div className="form-card">
          <div className="form-grid">
            <label>
              Title
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                placeholder="e.g. Memory and learning"
              />
            </label>
            <label>
              Course
              <select
                aria-label="Course"
                value={course}
                disabled={files.length > 0}
                onChange={(e) => setCourse(e.target.value)}
              >
                {data.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {isSet && (
            <div className="tabs">
              <button
                type="button"
                className={mode === 'upload' ? 'active' : ''}
                onClick={() => setMode('upload')}
              >
                <Sparkles size={17} />
                Create from materials
              </button>
              <button
                type="button"
                className={mode === 'manual' ? 'active' : ''}
                onClick={() => setMode('manual')}
              >
                <Pencil size={17} />
                Write your own
              </button>
            </div>
          )}
          {mode === 'upload' ? (
            <>
              <div
                role="button"
                tabIndex={0}
                aria-label="Choose material files"
                className={`dropzone ${drag ? 'dragging' : ''}`}
                onClick={() => input.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') input.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  void uploadFiles(e.dataTransfer.files);
                }}
              >
                <div className="upload-icon">
                  <UploadCloud size={31} />
                </div>
                <h3>
                  {isExam
                    ? 'Drop sample exams and course materials here'
                    : 'Drop your materials here'}
                </h3>
                <p>
                  or <span>browse files</span> on your device
                </p>
                <small>PDF, PowerPoint, Word, text, or images · 100 MB per file</small>
                <input
                  ref={input}
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,.pptx,.docx,.txt,.md,.csv,.tsv,.json,.html,.png,.jpg,.jpeg,.webp,.heic"
                  onChange={(e) => {
                    void uploadFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
              </div>
              <div className="upload-list" aria-live="polite">
                {files.map((f) => (
                  <div className="upload-item" key={f.key}>
                    <FileText size={23} />
                    <div className="grow">
                      <strong>{f.name}</strong>
                      <small className={f.error ? 'error-text' : ''}>
                        {f.error ||
                          (f.status === 'ready'
                            ? 'Ready to use'
                            : 'Uploading and reading your file…')}
                      </small>
                    </div>
                    {isExam && f.source && (
                      <label className="sample-checkbox">
                        <input
                          type="checkbox"
                          aria-label={`Use ${f.name} as a sample exam`}
                          checked={referenceSourceIds.includes(f.source.id)}
                          onChange={(e) =>
                            setReferenceSourceIds((prev) =>
                              e.target.checked
                                ? [...new Set([...prev, f.source!.id])]
                                : prev.filter((id) => id !== f.source!.id),
                            )
                          }
                        />
                        Sample exam
                      </label>
                    )}
                    {f.status === 'uploading' ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : f.status === 'ready' ? (
                      <Check size={20} className="success-text" />
                    ) : null}
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${f.name}`}
                      onClick={() => setFiles(files.filter((x) => x.key !== f.key))}
                    >
                      <X size={17} />
                    </button>
                  </div>
                ))}
              </div>
              {previousSources.length > 0 && (
                <details className="previous-sources">
                  <summary>Use previously uploaded materials</summary>
                  {previousSources.map((source) => (
                    <label className="source-picker" key={source.id}>
                      <input
                        type="checkbox"
                        checked={files.some((f) => f.source?.id === source.id)}
                        onChange={(e) =>
                          setFiles((prev) =>
                            e.target.checked
                              ? [
                                  ...prev,
                                  { key: source.id, name: source.name, status: 'ready', source },
                                ]
                              : prev.filter((f) => f.source?.id !== source.id),
                          )
                        }
                      />
                      <FileText size={15} />
                      <span>{source.name}</span>
                    </label>
                  ))}
                </details>
              )}
              <div className="gentle-note">
                <Layers size={18} />
                <span>
                  {isSet
                    ? 'Add as many files as you need. They become one cohesive set, with source references and useful diagrams.'
                    : isExam
                      ? 'Mark sample exams above. They guide the question style and structure. Add lectures, notes, and study guides for broader course coverage.'
                      : 'About 20 printable pages, with related terms grouped together and brief definitions and room for your explanations and personal examples. Shorter material may need fewer pages.'}
                </span>
              </div>
            </>
          ) : (
            <>
              <details className="import-area">
                <summary>Import terms and definitions</summary>
                <p>One card per line. Separate the term and definition with a tab.</p>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  placeholder={'Term\tDefinition'}
                />
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => {
                    const parsed = importText
                      .split('\n')
                      .filter((l) => l.trim())
                      .map((l) => {
                        const [term, ...parts] = l.split('\t');
                        return { ...blankCard(), term, definition: parts.join('\t') };
                      });
                    if (parsed.some((c) => !c.definition)) {
                      toast.error('Each line needs a term, a tab, and a definition.');
                      return;
                    }
                    setCards(parsed);
                    toast.success(`${parsed.length} cards imported`);
                  }}
                >
                  Import cards
                </button>
              </details>
              <CardEditor cards={cards} setCards={setCards} />
            </>
          )}
          <label>
            {mode === 'upload' ? `What should the ${label} focus on?` : 'Description'}{' '}
            <span className="muted">optional</span>
            <textarea
              maxLength={5000}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={
                mode === 'upload'
                  ? 'e.g. Focus on the mechanisms and distinctions we need for the midterm.'
                  : 'Add a little context for this set.'
              }
            />
          </label>
        </div>
        <div className="editor-bottom">
          <AgentPill harness={data.settings.agentHarness} />
          <button
            className="button primary"
            disabled={
              busy ||
              !title.trim() ||
              !course ||
              (mode === 'upload' &&
                (!ready.length || pending || files.some((f) => f.status === 'failed')))
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={19} />
            ) : mode === 'upload' ? (
              <Sparkles size={19} />
            ) : (
              <Check size={19} />
            )}{' '}
            {mode === 'upload' ? `Create ${label}` : 'Save study set'}
          </button>
        </div>
        {mode === 'upload' && (
          <p className="privacy-note">
            Your selected materials are sent to{' '}
            {data.settings.agentHarness === 'opencode'
              ? 'OpenCode using your connected account'
              : 'Codex using your existing ChatGPT login'}
            . Study data and source files stay saved on this device.
          </p>
        )}
      </form>
    </div>
  );
}
function CardEditor({ cards, setCards }: { cards: any[]; setCards: (c: any[]) => void }) {
  const update = (i: number, k: string, v: any) =>
    setCards(cards.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  return (
    <div className="card-editor">
      {cards.map((c, i) => (
        <div key={c.id || i} className="edit-card">
          <div className="row between">
            <span className="eyebrow">CARD {i + 1}</span>
            <button
              type="button"
              className="icon-button"
              disabled={cards.length <= 1}
              aria-label={`Remove card ${i + 1}`}
              onClick={() => setCards(cards.filter((_, j) => i !== j))}
            >
              <Trash2 size={17} />
            </button>
          </div>
          <div className="form-grid">
            <label>
              Term or question
              <textarea
                required
                value={c.term}
                onChange={(e) => update(i, 'term', e.target.value)}
                placeholder="Enter a term or question"
              />
            </label>
            <label>
              Definition or answer
              <textarea
                required
                value={c.definition}
                onChange={(e) => update(i, 'definition', e.target.value)}
                placeholder="Enter the answer"
              />
            </label>
          </div>
          {c.image && (
            <div className="editor-image">
              <CardVisual card={c} side={c.image.side} />
              <p>{c.image.reason}</p>
              <div className="row">
                <label>
                  Show image
                  <select
                    value={c.image.side}
                    onChange={(e) =>
                      update(i, 'image', {
                        ...c.image,
                        side: e.target.value,
                        matchUsable: e.target.value === 'question' && c.image.matchUsable,
                      })
                    }
                  >
                    <option value="question" disabled={c.image.revealsAnswer}>
                      With the question
                    </option>
                    <option value="answer">With the answer</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => update(i, 'image', null)}
                >
                  Remove image
                </button>
              </div>
            </div>
          )}
          <details>
            <summary>Question options & explanation</summary>
            <label>
              MCQ question
              <input
                value={c.question}
                onChange={(e) => update(i, 'question', e.target.value)}
                placeholder="Uses the term above if empty"
              />
            </label>
            <label>
              Incorrect options, one per line
              <textarea
                value={c.distractors.join('\n')}
                onChange={(e) => update(i, 'distractors', e.target.value.split('\n').slice(0, 3))}
                placeholder="Optional. Otherwise uses answers from other cards."
              />
            </label>
            <label>
              Accepted written answers, one per line
              <textarea
                value={c.aliases.join('\n')}
                onChange={(e) => update(i, 'aliases', e.target.value.split('\n').filter(Boolean))}
              />
            </label>
            <label>
              Explanation
              <textarea
                value={c.explanation}
                onChange={(e) => update(i, 'explanation', e.target.value)}
              />
            </label>
            <label>
              Topic
              <input value={c.topic} onChange={(e) => update(i, 'topic', e.target.value)} />
            </label>
          </details>
        </div>
      ))}
      <button
        type="button"
        className="button secondary add-card"
        onClick={() => setCards([...cards, blankCard()])}
      >
        <Plus size={18} />
        Add card
      </button>
    </div>
  );
}
export function EditSet() {
  const { setId } = useParams();
  const { refresh } = useApp();
  const [set, setSet] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    api(`/sets/${setId}`)
      .then(setSet)
      .catch((e) => setError(e.message));
  }, [setId]);
  if (error) return <Empty title="Set couldn't load" description={error} />;
  if (!set) return <Loading />;
  return (
    <div className="page editor-page">
      <Link to={`/sets/${setId}`} className="breadcrumb">
        <ArrowLeft size={16} />
        Back to set
      </Link>
      <div className="page-title">
        <h1>Edit your study set</h1>
        <p>
          Changes to a question reset its current progress. Your earlier attempts remain in your
          history.
        </p>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/sets/${setId}`, { method: 'PUT', body: JSON.stringify(set) });
            await refresh();
            navigate(`/sets/${setId}`);
            toast.success('Changes saved');
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Title
          <input
            required
            value={set.title}
            onChange={(e) => setSet({ ...set, title: e.target.value })}
          />
        </label>
        <label>
          Description
          <textarea
            value={set.description}
            onChange={(e) => setSet({ ...set, description: e.target.value })}
          />
        </label>
        <CardEditor cards={set.cards} setCards={(cards) => setSet({ ...set, cards })} />
        <div className="editor-bottom">
          <Link to={`/sets/${setId}`} className="button secondary">
            Cancel
          </Link>
          <button className="button primary" disabled={busy}>
            <Check size={18} />
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
export function ProgressPage() {
  const { data } = useApp();
  const [scope, setScope] = useState(''),
    [snap, setSnap] = useState<any>(null);
  useEffect(() => {
    api(`/progress${scope ? '?courseId=' + scope : ''}`)
      .then(setSnap)
      .catch((e) => toast.error(e.message));
  }, [scope, data.stats.attempts]);
  if (!snap) return <Loading />;
  const weak = snap.cards
    .filter(
      (c: any) =>
        c.progress.lastCorrect === false ||
        (c.progress.dueAt && c.progress.dueAt <= new Date().toISOString()),
    )
    .slice(0, 8);
  return (
    <div className="page">
      <div className="page-title row between">
        <div>
          <h1>Your progress</h1>
          <p>See what is sticking, and what deserves another look.</p>
        </div>
        <select
          aria-label="Filter progress by course"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="">All courses</option>
          {data.courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="metric-grid">
        <div className="metric">
          <span>Practice accuracy</span>
          <strong>{snap.stats.accuracy === null ? '—' : snap.stats.accuracy + '%'}</strong>
          <small>{snap.stats.attempts} objective answers</small>
        </div>
        <div className="metric">
          <span>Due for review</span>
          <strong>{snap.stats.due}</strong>
          <small>Cards to revisit</small>
        </div>
        <div className="metric">
          <span>Spaced successes</span>
          <strong>{snap.stats.retained}</strong>
          <small>Cards correct across 3+ spaced days</small>
        </div>
        <div className="metric">
          <span>Active study days</span>
          <strong>{snap.stats.studyDays}</strong>
          <small>{snap.stats.minutes} minutes answering</small>
        </div>
      </div>
      <section className="panel activity-panel">
        <div className="section-title">
          <h2>A little practice adds up</h2>
          <span className="muted">Last 28 days</span>
        </div>
        <div className="activity-chart">
          {snap.activity.map((d: any) => (
            <div className="activity-column" key={d.date} title={`${d.date}: ${d.count} answers`}>
              <div
                className={d.count ? 'filled' : ''}
                style={{
                  height: `${d.count ? Math.max(8, (d.count / Math.max(...snap.activity.map((x: any) => x.count), 1)) * 110) : 4}px`,
                }}
              />
              <small>{Number(d.date.slice(-2))}</small>
            </div>
          ))}
        </div>
      </section>
      <div className="section-title">
        <h2>Your next focus</h2>
        <Link to={`/insights${scope ? '?course=' + scope : ''}`} className="text-button">
          <Sparkles size={17} />
          Talk through my progress
        </Link>
      </div>
      {weak.length ? (
        <div className="focus-list">
          {weak.map((c: any) => (
            <Link key={c.id} className="focus-row" to={c.actions.learn}>
              <span className="focus-icon">
                <RotateCcw size={20} />
              </span>
              <div className="grow">
                <strong>{c.term}</strong>
                <p>
                  {c.topic} · {c.progress.correct} correct of {c.progress.objectiveAttempts}{' '}
                  attempts
                </p>
              </div>
              <span className="tag">
                {c.progress.lastCorrect === false ? 'Last answer missed' : 'Due for review'}
              </span>
              <ArrowRight size={20} />
            </Link>
          ))}
        </div>
      ) : (
        <Empty
          icon={<ChartNoAxesCombined size={30} />}
          title={
            snap.stats.attempts ? 'You are caught up for now' : 'Your progress starts with practice'
          }
          description={
            snap.stats.attempts
              ? 'Come back for spaced review, or practice a different set.'
              : 'Answer questions in Learn or Test to start seeing which concepts need your attention.'
          }
        >
          <Link className="button primary" to="/library">
            Choose a study set
            <ArrowRight size={17} />
          </Link>
        </Empty>
      )}
      <details className="metric-notes">
        <summary>How these numbers work</summary>
        {Object.entries(snap.metricDefinitions).map(([k, v]) => (
          <p key={k}>{String(v)}</p>
        ))}
      </details>
    </div>
  );
}
export function ChatPage() {
  const { data, refresh } = useApp();
  const [params] = useSearchParams();
  const [scope, setScope] = useState(params.get('course') || ''),
    [conversationId, setConversationId] = useState<string | null>(null),
    [conversations, setConversations] = useState<Conversation[]>([]),
    [messages, setMessages] = useState<ChatMessage[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [text, setText] = useState(''),
    [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const pending = jobs.find((j) => j.status === 'running' || j.status === 'queued');
  const failed = [...jobs]
    .reverse()
    .find((j) => j.status === 'failed' && !jobs.some((x) => x.createdAt > j.createdAt));
  useEffect(() => {
    api<Conversation[]>('/conversations').then(setConversations);
  }, [conversationId, data.jobs.length]);
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setJobs([]);
      return;
    }
    const load = () =>
      api(`/conversations/${conversationId}`)
        .then((c) => {
          setMessages(c.messages);
          setJobs(c.jobs);
          setScope(c.courseId || '');
        })
        .catch((e) => toast.error(e.message));
    void load();
    const timer = setInterval(load, 1800);
    return () => clearInterval(timer);
  }, [conversationId]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, pending?.status]);
  async function send(value = text) {
    if (!value.trim() || pending || sending) return;
    setSending(true);
    try {
      const r = await post('/chat', { message: value, courseId: scope || null, conversationId });
      setConversationId(r.conversationId);
      setJobs((p) => [...p, r.job]);
      setText('');
      const c = await api(`/conversations/${r.conversationId}`);
      setMessages(c.messages);
      void refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="chat-page">
      <div className="chat-header">
        <div className="row">
          <div className="insight-spark">
            <Sparkles size={23} />
          </div>
          <div>
            <h1>Study insights</h1>
            <p>A conversation about your learning.</p>
          </div>
        </div>
        <div className="row">
          <select
            aria-label="Conversation history"
            value={conversationId || ''}
            onChange={(e) => setConversationId(e.target.value || null)}
          >
            <option value="">New conversation</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            className="icon-button bordered"
            aria-label="New conversation"
            onClick={() => {
              setConversationId(null);
              setMessages([]);
              setJobs([]);
              setText('');
            }}
          >
            <Plus size={19} />
          </button>
        </div>
      </div>
      <div className="chat-scroll">
        {!messages.length ? (
          <div className="chat-welcome">
            <div className="chat-orb">
              <Sparkles size={37} strokeWidth={1.5} />
            </div>
            <h2>
              What should you
              <br />
              study next?
            </h2>
            <p>
              Ask about your progress, untangle what needs work,
              <br />
              or make a plan for your next study session.
            </p>
            <div className="prompt-grid">
              {[
                { icon: Target, text: 'What should I focus on next?' },
                { icon: ChartNoAxesCombined, text: 'How is my progress across my courses?' },
                { icon: Clock3, text: 'Help me plan a 20-minute study session.' },
                { icon: BookOpen, text: 'Which concepts am I still mixing up?' },
              ].map((p) => (
                <button key={p.text} onClick={() => void send(p.text)} disabled={sending}>
                  <p.icon size={20} />
                  <span>{p.text}</span>
                  <ArrowUp size={17} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="chat-messages">
            {messages.map((m) => (
              <div key={m.id} className={`chat-message ${m.role}`}>
                {m.role === 'assistant' && (
                  <div className="assistant-avatar">
                    <Sparkles size={18} />
                  </div>
                )}
                <div className="message-body">
                  <div className="markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                  {m.actions?.length > 0 && (
                    <div className="chat-actions">
                      {m.actions.map((a, i) => (
                        <Link to={a.path} key={i}>
                          <span className="action-icon">
                            <BookOpen size={20} />
                          </span>
                          <div>
                            <strong>{a.label}</strong>
                            <p>{a.reason}</p>
                          </div>
                          <ArrowRight size={18} />
                        </Link>
                      ))}
                    </div>
                  )}
                  {m.evidence?.length > 0 && (
                    <details className="evidence">
                      <summary>
                        <FileText size={13} />
                        Based on your study data
                      </summary>
                      {m.evidence.map((e, i) => (
                        <p key={i}>{e}</p>
                      ))}
                    </details>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {pending && (
          <div className="chat-thinking">
            <span className="thinking-dots">
              <i />
              <i />
              <i />
            </span>
            <span>{pending.stage}</span>
            <button
              className="text-button"
              onClick={async () => {
                await post(`/jobs/${pending.id}/cancel`, {});
                setJobs(jobs.map((j) => (j.id === pending.id ? { ...j, status: 'cancelled' } : j)));
              }}
            >
              Stop
            </button>
          </div>
        )}
        {failed && (
          <div className="chat-failure">
            <p>{failed.error}</p>
            <button
              className="button secondary small"
              onClick={async () => {
                const j = await post(`/jobs/${failed.id}/retry`, {});
                setJobs((p) => [...p, j]);
              }}
            >
              Try again
            </button>
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="chat-composer-wrap">
        <div className="chat-scope">
          <BookOpen size={14} />
          <select
            aria-label="Insight course scope"
            value={scope}
            disabled={Boolean(conversationId)}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="">All your courses</option>
            {data.courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span>Grounded in your saved progress</span>
        </div>
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="Ask about your progress"
            placeholder="What would you like to understand about your learning?"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          <button
            aria-label="Send message"
            className="send-button"
            disabled={!text.trim() || Boolean(pending) || sending}
          >
            {sending ? <LoaderCircle className="spin" size={20} /> : <ArrowUp size={21} />}
          </button>
        </form>
        <small className="chat-disclosure">
          {data.settings.agentHarness === 'opencode' ? 'Uses OpenCode.' : 'Uses your Codex login.'}{' '}
          Recommendations reflect practice history, not a prediction of exam results.
        </small>
      </div>
    </div>
  );
}
export function SettingsPage() {
  const { data, refresh } = useApp();
  const [settings, setSettings] = useState<any>(null),
    [archived, setArchived] = useState<any>({ courses: [], sets: [], documents: [] }),
    [name, setName] = useState(data.settings.name || '');
  useEffect(() => {
    api('/settings').then(setSettings);
    api('/archive').then(setArchived);
  }, [data.courses.length, data.sets.length, data.documents?.length]);
  return (
    <div className="page settings-page">
      <div className="page-title">
        <h1>Settings & data</h1>
        <p>Your study space. Your data.</p>
      </div>
      <section className="panel">
        <h2>Make yourself at home</h2>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            await patch('/settings', { name });
            await refresh();
            toast.success('Name saved');
          }}
        >
          <label className="grow">
            Your name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="What should we call you?"
            />
          </label>
          <button className="button secondary">Save</button>
        </form>
      </section>
      <section className="panel">
        <h2>Saved on this device</h2>
        <p>
          Courses, source files, answer history, and conversations live in one local folder. SQLite
          backups run daily while the app is open.
        </p>
        <code className="data-path">{settings?.dataPath}</code>
        <div className="row wrap">
          <a className="button primary" href="/api/export" download>
            <Download size={18} />
            Export all data
          </a>
          <button
            className="button secondary"
            onClick={async () => {
              await post('/backup', {});
              toast.success('Today’s database backup is ready');
            }}
          >
            <Archive size={18} />
            Back up database
          </button>
        </div>
        <p className="small muted">
          The JSON export includes study records and source metadata. Keep the data folder for the
          original material files, images, and agent receipts.
        </p>
        <details>
          <summary>Agent access and data definitions</summary>
          <p>
            Use <code>npm run data -- summary</code> or <code>npm run data -- snapshot</code> in
            this project for a readable, versioned snapshot. Every attempt stores a stable card ID,
            question version, mode, answer, and timestamp.
          </p>
          <p>
            Project skills live in <code>.agents/skills</code>. The app launches one agent job at a
            time in this project, with a read-only sandbox and strict JSON output. Pick Codex or
            OpenCode under Advanced (AI).
          </p>
        </details>
      </section>
      <section className="panel">
        <h2>Background study agents</h2>
        <p>
          Set creation and insights use your selected agent and its usage limits. Normal studying
          works without an internet connection.
        </p>
        <div className="settings-fact">
          <span>Local address</span>
          <a href="http://localhost:3210">localhost:3210</a>
        </div>
        <div className="settings-fact">
          <span>Provider</span>
          <strong>
            {data.settings.agentHarness === 'opencode'
              ? 'OpenCode · connected account'
              : 'Codex CLI · existing ChatGPT login'}
          </strong>
        </div>
        <JobList jobs={data.jobs.slice(0, 5)} refresh={refresh} />
        {data.jobs.length > 0 && (
          <details>
            <summary>Job diagnostics</summary>
            {data.jobs.slice(0, 10).map((j) => (
              <p key={j.id}>
                <a href={`/api/jobs/${j.id}/log`} target="_blank" rel="noreferrer">
                  {j.payload.title || 'Insights'} · {j.status} ·{' '}
                  {new Date(j.createdAt).toLocaleString()}
                </a>
              </p>
            ))}
          </details>
        )}
      </section>
      <AgentSettings />
      <section className="panel">
        <h2>Archived items</h2>
        <p>Restore a course, study set, exam, or retrieval packet.</p>
        {[
          ...archived.courses.map((c: any) => ({ ...c, kind: 'courses' })),
          ...archived.sets.map((s: any) => ({ ...s, kind: 'sets' })),
          ...(archived.documents || []).map((d: any) => ({ ...d, kind: 'documents' })),
        ].map((x: any) => (
          <div className="settings-fact" key={x.id}>
            <span>{x.name || x.title}</span>
            <button
              className="text-button"
              onClick={async () => {
                await patch(`/${x.kind}/${x.id}`, { archived: false });
                await refresh();
                toast.success('Restored');
              }}
            >
              <RotateCcw size={16} />
              Restore
            </button>
          </div>
        ))}
        {!archived.courses.length &&
          !archived.sets.length &&
          !(archived.documents || []).length && <p className="muted">Nothing archived.</p>}
      </section>
    </div>
  );
}
