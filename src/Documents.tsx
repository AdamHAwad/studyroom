import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Printer,
  RotateCcw,
  Archive,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useApp } from './App';
import { api, patch, post } from './api';
import { Empty, Loading, Modal } from './ui';
import type { StudyDocument, Course } from './types';

export function DocumentTile({ document, course }: { document: StudyDocument; course?: Course }) {
  return (
    <Link to={`/documents/${document.id}`} className="set-tile">
      <div className="row between">
        <span className="tag">
          {document.kind === 'practice-exam' ? 'Practice exam' : 'Retrieval packet'}
        </span>
        <FileText size={20} className="muted" />
      </div>
      <h3>{document.title}</h3>
      <p>{document.description}</p>
      <div className="tile-footer">
        <span className={`course-dot ${course?.color || 'purple'}`} />
        <span>{course?.code || course?.name || 'Study materials'}</span>
        <ArrowRight size={17} />
      </div>
    </Link>
  );
}

export function DocumentPage() {
  const { documentId } = useParams();
  const { data, refresh } = useApp();
  const [document, setDocument] = useState<StudyDocument | null>(null);
  const [error, setError] = useState('');
  const [answers, setAnswers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [archive, setArchive] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    setDocument(null);
    setError('');
    api<StudyDocument>(`/documents/${documentId}`)
      .then(setDocument)
      .catch((e) => setError(e.message));
  }, [documentId]);
  if (error)
    return (
      <Empty title="Couldn't open this document" description={error}>
        <Link to="/library" className="button secondary">
          Your library
        </Link>
      </Empty>
    );
  if (!document) return <Loading />;
  const course = data.courses.find((c) => c.id === document.courseId);
  const printUrl = `/api/documents/${document.id}/print${answers ? '?answers=1' : ''}`;
  return (
    <div className="page document-page">
      <Link className="breadcrumb" to={`/courses/${document.courseId}`}>
        <ArrowLeft size={15} />
        {course?.name || 'Back to course'}
      </Link>
      <div className="page-title row between">
        <div>
          <span className="eyebrow">
            {document.kind === 'practice-exam' ? 'PRACTICE EXAM' : 'RETRIEVAL PACKET'}
          </span>
          <h1>{document.title}</h1>
          <p>{document.description}</p>
        </div>
        <button
          className="icon-button"
          aria-label="Archive document"
          onClick={() => setArchive(true)}
        >
          <Archive size={20} />
        </button>
      </div>
      <div className="document-actions row between">
        <div className="tabs">
          <button onClick={() => setAnswers(false)} className={!answers ? 'active' : ''}>
            Student copy
          </button>
          <button onClick={() => setAnswers(true)} className={answers ? 'active' : ''}>
            Answer key
          </button>
        </div>
        <div className="row">
          <button
            className="button secondary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/documents/${document.id}/generate`, {});
                await refresh();
                toast.success('A new version is being created.');
                navigate(`/courses/${document.courseId}`);
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle size={17} className="spin" /> : <RotateCcw size={17} />}Generate
            another
          </button>
          <a className="button primary" href={printUrl} target="_blank" rel="noreferrer">
            <Printer size={17} />
            Print / Save PDF
          </a>
        </div>
      </div>
      {document.kind === 'retrieval-packet' && (
        <p className="print-hint">
          Print the student copy double-sided on Letter paper. Keep the answer key separate until
          you've finished.
        </p>
      )}
      {(document.warnings.length > 0 || document.content.omittedTerms.length > 0) && (
        <details className="document-notes">
          <summary>Coverage notes</summary>
          {document.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
          {document.content.omittedTerms.length > 0 && (
            <p>Additional terms for another round: {document.content.omittedTerms.join(', ')}.</p>
          )}
        </details>
      )}
      <iframe
        key={printUrl}
        className="document-preview"
        title={`${document.title} ${answers ? 'answer key' : 'student copy'}`}
        src={printUrl}
      />
      <details className="document-notes">
        <summary>Source materials</summary>
        {document.sourceIds.map((sourceId) => (
          <p key={sourceId}>
            <a href={`/api/sources/${sourceId}/file`} target="_blank" rel="noreferrer">
              {document.content.evidence.find((e) => e.sourceId === sourceId)?.name ||
                'Source material'}
            </a>
            {document.referenceSourceIds.includes(sourceId) ? ' · Sample exam' : ''}
          </p>
        ))}
      </details>
      <Modal
        open={archive}
        onOpenChange={setArchive}
        title="Archive this document?"
        description="It stays saved and can be restored from Settings."
      >
        <div className="modal-footer">
          <button className="button secondary" onClick={() => setArchive(false)}>
            Keep document
          </button>
          <button
            className="button primary"
            onClick={async () => {
              try {
                await patch(`/documents/${document.id}`, { archived: true });
                await refresh();
                navigate(`/courses/${document.courseId}`);
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          >
            Archive
          </button>
        </div>
      </Modal>
    </div>
  );
}
