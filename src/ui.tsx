import { useState, useEffect, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  X,
  ArrowRight,
  Layers,
  BookOpen,
  Plus,
  LoaderCircle,
  Sparkles,
  Check,
  AlertCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { post, patch } from './api';
import type { Course, StudySet, Job } from './types';
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className={`modal ${wide ? 'wide' : ''}`}>
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description className={description ? 'modal-description' : 'sr-only'}>
            {description || title}
          </Dialog.Description>
          <Dialog.Close className="icon-button modal-close" aria-label="Close">
            <X size={20} />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Empty({
  icon = <Layers size={30} />,
  title,
  description,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h2>{title}</h2>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function CourseModal({
  open,
  onOpenChange,
  refresh,
  course,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  refresh: () => void;
  course?: Course;
}) {
  const [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [color, setColor] = useState('purple'),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(course?.name || '');
      setCode(course?.code || '');
      setColor(course?.color || 'purple');
    }
  }, [open, course?.id]);
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={course ? 'Edit course' : 'Create a course'}
      description="A home for your materials, study sets, and progress."
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (course) await patch(`/courses/${course.id}`, { name, code, color });
            else await post('/courses', { name, code, color });
            refresh();
            onOpenChange(false);
            setName('');
            setCode('');
            toast.success(course ? 'Course updated' : 'Course created');
          } catch (e) {
            toast.error((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Course name
          <input
            autoFocus
            required
            maxLength={120}
            placeholder="e.g. Cognitive psychology"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Course code <span className="muted">optional</span>
          <input
            maxLength={30}
            placeholder="e.g. PSYC 201"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label>Color</label>
        <div className="color-picker">
          {['purple', 'blue', 'green', 'orange', 'pink', 'teal'].map((c) => (
            <button
              type="button"
              key={c}
              className={`color-swatch ${c} ${c === color ? 'selected' : ''}`}
              aria-label={c}
              aria-pressed={c === color}
              onClick={() => setColor(c)}
            >
              {c === color && <Check size={18} />}
            </button>
          ))}
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />}{' '}
            {course ? 'Save changes' : 'Create course'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function SetTile({ set, course }: { set: StudySet; course?: Course }) {
  return (
    <Link to={`/sets/${set.id}`} className="set-tile">
      <div className="row between">
        <span className="tag">{set.cardCount} terms</span>
        <Layers size={20} className="muted" />
      </div>
      <h3>{set.title}</h3>
      <p>{set.description || 'Your next study session starts here.'}</p>
      <div className="tile-footer">
        <span className={`course-dot ${course?.color || 'purple'}`} />
        <span>{course?.code || course?.name || 'Study set'}</span>
        <ArrowRight size={17} />
      </div>
    </Link>
  );
}
export function CourseTile({ course, count }: { course: Course; count: number }) {
  return (
    <Link className={`course-tile ${course.color}`} to={`/courses/${course.id}`}>
      <div className="course-art">
        <BookOpen size={32} strokeWidth={1.7} />
        <span>{course.code || 'COURSE'}</span>
      </div>
      <div className="course-tile-body">
        <h3>{course.name}</h3>
        <p>
          {count} study {count === 1 ? 'set' : 'sets'}
        </p>
        <ArrowRight size={20} />
      </div>
    </Link>
  );
}
export function JobList({ jobs, refresh }: { jobs: Job[]; refresh: () => void }) {
  return (
    <div className="job-list">
      {jobs.map((j) => (
        <div className="job" key={j.id}>
          <div className={`job-icon ${j.status === 'failed' ? 'error' : ''}`}>
            {j.status === 'running' || j.status === 'queued' ? (
              <LoaderCircle className="spin" size={21} />
            ) : j.status === 'completed' ? (
              <Check size={21} />
            ) : (
              <AlertCircle size={21} />
            )}
          </div>
          <div className="grow">
            <strong>
              {['set', 'practice-exam', 'retrieval-packet'].includes(j.kind)
                ? j.payload.title
                : j.kind === 'review'
                  ? `Quality review · ${j.payload.setId?.slice(0, 8) || 'saved set'}`
                  : 'Study insights'}
            </strong>
            <p>
              {j.stage}
              {j.status === 'running' &&
                ` · ${Math.max(1, Math.floor((Date.now() - Date.parse(j.createdAt)) / 60000))} min elapsed`}
            </p>
            {j.status === 'running' && (
              <>
                <div className="progress-track">
                  <div style={{ width: `${j.progress}%` }} />
                </div>
                <p>
                  You can keep studying or leave this page. Your work will appear in this course
                  when ready.
                </p>
              </>
            )}
            {(j as any).requirements?.cardCount &&
              (() => {
                const { min, max } = (j as any).requirements.cardCount;
                if (min === null && max === null) return null;
                const count =
                  min !== null && max !== null
                    ? min === max
                      ? `Exactly ${min}`
                      : `${min}–${max}`
                    : min !== null
                      ? `At least ${min}`
                      : `At most ${max}`;
                return <p className="small muted">Requested set size: {count} cards</p>;
              })()}
            {Number((j as any).details?.stagedCards) > 0 && (
              <p className="small muted">{(j as any).details.stagedCards} cards ready so far</p>
            )}
            {j.error && <p className="error-text">{j.error}</p>}
          </div>
          {j.status === 'completed' &&
          ['set', 'review', 'practice-exam', 'retrieval-packet'].includes(j.kind) ? (
            <Link
              className="button secondary small"
              to={`${['set', 'review'].includes(j.kind) ? '/sets/' : '/documents/'}${j.resultId}`}
            >
              {['set', 'review'].includes(j.kind) ? 'Open set' : 'Open document'}
              <ArrowRight size={15} />
            </Link>
          ) : ['failed', 'cancelled'].includes(j.status) ? (
            <button
              className="button secondary small"
              onClick={async () => {
                try {
                  await post(`/jobs/${j.id}/retry`, {});
                  refresh();
                  toast.success('Job queued');
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Retry
            </button>
          ) : ['queued', 'running'].includes(j.status) ? (
            <button
              className="icon-button"
              aria-label="Cancel job"
              onClick={async () => {
                await post(`/jobs/${j.id}/cancel`, {});
                refresh();
              }}
            >
              <X size={17} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Studyroom home">
      <span className="brand-mark">
        <Layers size={23} strokeWidth={2.5} />
      </span>
      studyroom<span className="brand-period">.</span>
    </Link>
  );
}
export function Loading() {
  return (
    <div className="loading">
      <LoaderCircle size={30} className="spin" />
      <span>Loading your study space</span>
    </div>
  );
}
export function AgentPill({ harness }: { harness?: string }) {
  return (
    <span className="agent-pill">
      <Sparkles size={13} /> Powered by {harness === 'opencode' ? 'OpenCode' : 'your Codex'}
    </span>
  );
}
