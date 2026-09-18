import { useEffect, useRef, useState } from 'react';
import { Bell, Download, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, post } from '../api';
import { Modal } from '../ui';

type Commit = { sha: string; short: string; date: string; subject: string };
type UpdateStatus = {
  supported: boolean;
  reason: string | null;
  available: boolean;
  behind: number;
  current: Commit | null;
  latest: Commit | null;
  phase: 'idle' | 'running' | 'done' | 'error';
  step: string | null;
  message: string | null;
};
const dismissedKey = 'studyroom.update.dismissed';

export default function UpdateNotice() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const s = await post<UpdateStatus>('/update/check', {});
        if (!active) return;
        setStatus(s);
        if (s.phase === 'running') setBusy(true);
        if (first.current) {
          first.current = false;
          if (s.available && s.latest && localStorage.getItem(dismissedKey) !== s.latest.sha)
            setOpen(true);
        }
      } catch {}
    };
    void run();
    const timer = window.setInterval(run, 60 * 60 * 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    let cancelled = false;
    let timer = 0;
    const startedAt = Date.now();
    const poll = async () => {
      if (cancelled) return;
      try {
        const s = await api<UpdateStatus>('/update');
        if (cancelled) return;
        setStatus(s);
        if (s.phase === 'error') {
          setError(s.message || 'The update did not finish.');
          setBusy(false);
          return;
        }
        if (s.current && s.latest && s.current.sha === s.latest.sha) {
          location.reload();
          return;
        }
      } catch {}
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        setError('Studyroom is taking longer than expected to come back.');
        setTimedOut(true);
        setBusy(false);
        return;
      }
      timer = window.setTimeout(poll, 2000);
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [busy]);
  const start = async () => {
    setError('');
    setTimedOut(false);
    setBusy(true);
    try {
      await post('/update/apply', {});
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };
  const latest = status?.latest;
  return (
    <>
      {status?.available || busy ? (
        <button
          className="icon-button update-bell"
          aria-label="Update available"
          onClick={() => setOpen(true)}
        >
          {busy ? <LoaderCircle size={20} className="spin" /> : <Bell size={20} />}
          {status?.available && !busy && <span className="update-ping" />}
        </button>
      ) : null}
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={busy ? 'Updating Studyroom' : error ? 'Update did not finish' : 'Update available'}
        description={
          busy
            ? 'This can take a minute. Studyroom will restart on its own.'
            : error
              ? error
              : 'A newer version of Studyroom is ready.'
        }
      >
        {busy ? (
          <div className="update-progress">
            <LoaderCircle size={22} className="spin" />
            <span>{status?.step || 'Updating'}…</span>
          </div>
        ) : error ? (
          <>
            <p className="small muted">
              {timedOut
                ? 'Reload this page once Studyroom is back. Your courses and study history are safe.'
                : 'You can try again, or update from the terminal.'}
            </p>
            <div className="modal-footer">
              <button className="button secondary" onClick={() => setOpen(false)}>
                Close
              </button>
              {timedOut ? (
                <button className="button primary" onClick={() => location.reload()}>
                  <RefreshCw size={18} />
                  Reload page
                </button>
              ) : (
                <button className="button primary" onClick={start}>
                  <RefreshCw size={18} />
                  Try again
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="settings-fact">
              <span>New version</span>
              <strong>
                {latest?.short}
                {latest?.date ? ` · ${latest.date}` : ''}
              </strong>
            </div>
            {latest?.subject && <p className="small muted update-subject">{latest.subject}</p>}
            <p className="small muted">
              Updating restarts Studyroom. Your courses and study history are not affected.
            </p>
            <div className="modal-footer">
              <button
                className="button secondary"
                onClick={() => {
                  if (latest) localStorage.setItem(dismissedKey, latest.sha);
                  setOpen(false);
                }}
              >
                Not now
              </button>
              <button className="button primary" onClick={start}>
                <Download size={18} />
                Update now
              </button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
