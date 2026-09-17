import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Check, Download, LoaderCircle, LogIn } from 'lucide-react';
import { api, patch, post } from '../api';
import { useApp } from '../App';
import { Modal } from '../ui';

type Harness = 'codex' | 'opencode';
type ModelOption = {
  id: string;
  label: string;
  provider: string;
  efforts: string[];
  defaultEffort: string;
  image: boolean;
};
type ProcessState = {
  status: string;
  lines: string[];
  error: string | null;
} | null;
type HarnessState = {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  detail: string | null;
  providers: string[];
  install: ProcessState;
  login: ProcessState;
};
type AgentStatus = {
  harness: Harness;
  codex: HarnessState;
  opencode: HarnessState;
  selected: Record<Harness, { model: string; effort: string }>;
};
const HARNESSES: Harness[] = ['codex', 'opencode'];
const META: Record<Harness, { name: string; blurb: string; login: string }> = {
  codex: {
    name: 'Codex CLI',
    blurb: 'OpenAI Codex with your ChatGPT sign-in.',
    login: 'Sign in with ChatGPT',
  },
  opencode: {
    name: 'OpenCode',
    blurb: 'OpenCode with your OpenCode Go account.',
    login: 'Connect OpenCode Go',
  },
};
const PROVIDER_LABELS: Record<string, string> = {
  'opencode-go': 'OpenCode Go',
  opencode: 'OpenCode Zen',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
};
const modelSetting = (harness: Harness) =>
  harness === 'codex' ? 'agentCodexModel' : 'agentOpencodeModel';
const effortSetting = (harness: Harness) =>
  harness === 'codex' ? 'agentCodexEffort' : 'agentOpencodeEffort';
function groupModels(models: ModelOption[]) {
  const groups: Record<string, ModelOption[]> = {};
  for (const model of models) (groups[model.provider] ||= []).push(model);
  return groups;
}
export function AgentSettings() {
  const { refresh } = useApp();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [models, setModels] = useState<Partial<Record<Harness, ModelOption[]>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const loadingModels = useRef(new Set<Harness>());
  const loadStatus = async () => {
    try {
      setStatus(await api<AgentStatus>('/agent/status'));
    } catch {}
  };
  useEffect(() => {
    loadStatus();
    const timer = setInterval(loadStatus, 4000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!status) return;
    for (const harness of HARNESSES) {
      if (
        status[harness].installed &&
        models[harness] === undefined &&
        !loadingModels.current.has(harness)
      ) {
        loadingModels.current.add(harness);
        api<{ models: ModelOption[] }>(`/agent/models?harness=${harness}`)
          .then((result) => setModels((current) => ({ ...current, [harness]: result.models })))
          .catch(() => {})
          .finally(() => loadingModels.current.delete(harness));
      }
    }
  }, [status, models]);
  const selected = (harness: Harness) => status?.selected[harness] || { model: '', effort: '' };
  const recommended = (harness: Harness) => {
    const list = models[harness] || [];
    if (harness === 'codex')
      return list.find((model) => model.id === 'gpt-5.6-sol')?.id || list[0]?.id || '';
    return (
      list.find((model) => model.id === 'opencode-go/gpt-5.6-luna')?.id ||
      list.find((model) => model.provider === 'opencode-go' && model.image)?.id ||
      list.find((model) => model.provider === 'opencode-go')?.id ||
      list[0]?.id ||
      ''
    );
  };
  const activeModel = (harness: Harness) => selected(harness).model || recommended(harness);
  const currentModel = (harness: Harness) =>
    (models[harness] || []).find((model) => model.id === activeModel(harness));
  const chooseHarness = async (harness: Harness) => {
    const body: Record<string, string> = { agentHarness: harness };
    if (!selected(harness).model && recommended(harness))
      body[modelSetting(harness)] = recommended(harness);
    try {
      await patch('/settings', body);
      await refresh();
      await loadStatus();
      toast.success(`${META[harness].name} selected`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const chooseModel = async (harness: Harness, model: string) => {
    const next = (models[harness] || []).find((option) => option.id === model);
    const body: Record<string, string> = { [modelSetting(harness)]: model };
    if (selected(harness).effort && next && !next.efforts.includes(selected(harness).effort))
      body[effortSetting(harness)] = '';
    try {
      await patch('/settings', body);
      await loadStatus();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const chooseEffort = async (harness: Harness, effort: string) => {
    try {
      await patch('/settings', { [effortSetting(harness)]: effort });
      await loadStatus();
    } catch (error) {
      toast.error((error as Error).message);
    }
  };
  const install = async (harness: Harness) => {
    setBusy(`install:${harness}`);
    try {
      await post('/agent/install', { harness });
      await loadStatus();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const login = async (harness: Harness) => {
    if (harness === 'opencode') {
      setKeyOpen(true);
      return;
    }
    setBusy(`login:${harness}`);
    try {
      await post('/agent/login', { harness });
      toast.success('Finish signing in through the browser window that just opened');
      await loadStatus();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const connectOpencode = async (event: FormEvent) => {
    event.preventDefault();
    setBusy('login:opencode');
    try {
      await post('/agent/login', { harness: 'opencode', apiKey });
      setApiKey('');
      setKeyOpen(false);
      await loadStatus();
      toast.success('OpenCode Go connected');
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="panel">
      <h2>Advanced (AI)</h2>
      <p>
        Choose which local agent runs set creation, quality review, and study insights. Codex is the
        default. Both use an account you already own, and studying offline never changes.
      </p>
      <div className="agent-grid">
        {HARNESSES.map((harness) => {
          const state = status?.[harness];
          const installing = busy === `install:${harness}` || state?.install?.status === 'running';
          const signingIn = busy === `login:${harness}` || state?.login?.status === 'running';
          const active = status?.harness === harness;
          const model = currentModel(harness);
          const logline = (state?.install?.lines || state?.login?.lines || []).at(-1);
          return (
            <div key={harness} className={`agent-card ${state && !state.installed ? 'off' : ''}`}>
              <div className="agent-card-head">
                <div className="grow">
                  <strong>{META[harness].name}</strong>
                  <p className="small muted">{state?.detail || META[harness].blurb}</p>
                </div>
                {state?.installed && (
                  <input
                    type="checkbox"
                    className="switch"
                    role="switch"
                    aria-label={`Use ${META[harness].name}`}
                    checked={active}
                    disabled={!state.loggedIn}
                    onChange={() => chooseHarness(harness)}
                  />
                )}
              </div>
              <div className="row wrap agent-card-actions">
                {state && !state.installed ? (
                  <button
                    className="button secondary small"
                    disabled={installing}
                    onClick={() => install(harness)}
                  >
                    {installing ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Download size={16} />
                    )}
                    {installing ? 'Installing…' : 'Install'}
                  </button>
                ) : state?.installed && !state.loggedIn ? (
                  <button
                    className="button primary small"
                    disabled={signingIn}
                    onClick={() => login(harness)}
                  >
                    {signingIn ? <LoaderCircle className="spin" size={16} /> : <LogIn size={16} />}
                    {META[harness].login}
                  </button>
                ) : state?.installed ? (
                  <span className="agent-status">
                    <Check size={15} />
                    Connected{state.version ? ` · ${state.version}` : ''}
                  </span>
                ) : null}
              </div>
              {(installing || signingIn) && logline && (
                <p className="small muted agent-log">{logline}</p>
              )}
              {state?.install?.status === 'failed' && (
                <p className="error-text small">{state.install.error || logline}</p>
              )}
              {state?.login?.status === 'failed' && (
                <p className="error-text small">{state.login.error || logline}</p>
              )}
              {state?.installed && !state.loggedIn && harness === 'opencode' && (
                <p className="small muted">
                  Need a key?{' '}
                  <a href="https://opencode.ai/auth" target="_blank" rel="noreferrer">
                    opencode.ai/auth
                  </a>
                </p>
              )}
              {active && state?.installed && state.loggedIn && (
                <div className="agent-options">
                  <label>
                    Model
                    <select
                      value={activeModel(harness)}
                      disabled={!models[harness]?.length}
                      onChange={(event) => chooseModel(harness, event.target.value)}
                    >
                      {!activeModel(harness) && <option value="">No models available</option>}
                      {harness === 'codex'
                        ? (models[harness] || []).map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))
                        : Object.entries(groupModels(models[harness] || [])).map(
                            ([provider, list]) => (
                              <optgroup
                                key={provider}
                                label={PROVIDER_LABELS[provider] || provider}
                              >
                                {list.map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                              </optgroup>
                            ),
                          )}
                    </select>
                  </label>
                  <label>
                    Reasoning effort
                    <select
                      value={selected(harness).effort}
                      disabled={!model?.efforts.length}
                      onChange={(event) => chooseEffort(harness, event.target.value)}
                    >
                      <option value="">Default</option>
                      {selected(harness).effort &&
                        !model?.efforts.includes(selected(harness).effort) && (
                          <option value={selected(harness).effort}>
                            {selected(harness).effort}
                          </option>
                        )}
                      {(model?.efforts || []).map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </select>
                  </label>
                  {model && !model.image && (
                    <p className="small muted agent-warning">
                      This model is text-only, so diagram cards may lose their visuals.
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Modal
        open={keyOpen}
        onOpenChange={setKeyOpen}
        title="Connect OpenCode Go"
        description="Paste the API key from your OpenCode account."
      >
        <form onSubmit={connectOpencode}>
          <label>
            API key
            <input
              autoFocus
              type="password"
              required
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-…"
            />
          </label>
          <p className="small muted">
            Create or copy a key at opencode.ai/auth. It is stored only on this device with owner-only
            permissions and is never sent anywhere except OpenCode.
          </p>
          <div className="modal-footer">
            <button type="button" className="button secondary" onClick={() => setKeyOpen(false)}>
              Cancel
            </button>
            <button
              className="button primary"
              disabled={busy === 'login:opencode' || !apiKey.trim()}
            >
              {busy === 'login:opencode' ? <LoaderCircle className="spin" size={17} /> : null}
              Connect
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
