import { useEffect, useState } from 'react';
import { productionApi } from '../api';
import { useStudioStore } from '../store';
import type { StudioBuild } from '../types';
import { GamePlanEditor, readGamePlan } from './GamePlanEditor';

export type GamePlan = { schema: 'LillyGamePlan/v1'; foundation?: 'authored' | 'expedition'; name: string; fantasy: string; artDirection: string; coreLoop: string[]; winCondition: string; loseCondition: string; controls: string[]; acceptance: string[]; deferred: string[]; levelPrompt: string; scenePrompt?: string; environmentPrompt: string | null; gameplayPrompt: string; assets: Array<{ id: string; name: string; prompt: string; placement: string; targetEntityId?: string }> };
export type GameProduction = {
  id: string; brief: string; revision: number; status: string; createdAt: string; projectId: string | null;
  plan: GamePlan | null; models: Record<string, string>; taskModels?: Record<string, string>; concurrency: number; build?: StudioBuild;
  error?: { code: string; message: string };
  tasks: Array<{ id: string; name: string; role: string; model?: string; status: string; attempts: number; error?: string; proposalId?: string; appliedRevision?: number; testResults?: { passed: number; failed: number } }>;
  events: Array<{ sequence: number; at: string; taskId: string | null; message: string }>;
};
const ROLES = ['director', 'level', 'environment', 'asset', 'gameplay'];
const LABELS: Record<string, string> = { director: 'Game designer', level: 'Level builder', environment: 'Scenery builder', asset: '3D model builders', gameplay: 'Gameplay programmer' };
const running = (value?: GameProduction | null) => !!value && ['planning', 'building', 'stopping'].includes(value.status);

export function GameProductionCreator({ model, models }: { model: string; models: Array<{ id: string; name?: string }> }) {
  const [brief, setBrief] = useState('A woodland treasure hunt: explore a ruined temple, collect golden seeds, evade guardians and reach the beacon. Give the explorer a short magical dash, with mossy stone scenery and a distinctive seed model.');
  const [productions, setProductions] = useState<GameProduction[]>([]);
  const [production, setProduction] = useState<GameProduction | null>(null);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [taskAssignments, setTaskAssignments] = useState<Record<string, string>>({});
  const [concurrency, setConcurrency] = useState(2);
  const [planText, setPlanText] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const busy = pending || running(production) || production?.status === 'ready';
  const openProject = useStudioStore(state => state.openProject);

  useEffect(() => {
    let alive = true;
    productionApi.list().then(result => {
      if (!alive) return;
      setProductions(result.productions);
      const latest = result.productions[0];
      if (latest) { setProduction(latest); setAssignments(latest.models); setTaskAssignments(latest.taskModels || {}); setConcurrency(latest.concurrency); }
    }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (production?.plan) setPlanText(JSON.stringify(production.plan, null, 2));
  }, [production?.id, production?.status === 'review']);
  useEffect(() => {
    if (!production || !running(production)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await productionApi.get(production.id);
        if (!alive) return;
        setProduction(result); setError('');
        if (running(result)) timer = setTimeout(poll, 2500);
      } catch (e) {
        if (alive) { setError(`${(e as Error).message}. Reconnecting to saved progress…`); timer = setTimeout(poll, 5000); }
      }
    };
    timer = setTimeout(poll, 1000);
    return () => { alive = false; clearTimeout(timer); };
  }, [production?.id, running(production)]);
  const perform = async (action: () => Promise<GameProduction>) => {
    setPending(true); setError('');
    try {
      const result = await action();
      setProduction(result);
      setProductions(previous => [result, ...previous.filter(item => item.id !== result.id)]);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };
  const selectedModels = Object.fromEntries(ROLES.map(role => [role, assignments[role] ?? model]));
  const draft = readGamePlan(planText);
  const plan = production?.status === 'review' ? draft : production?.plan;
  return <div className="level-creator game-production">
    <div className="creator-intro"><div><span className="panel-kicker">Design → build together → play</span><strong>Build a whole game</strong></div></div>
    {!production && <p className="creator-help">Start with an idea. Review the design, then let model workers create the level, scenery, 3D assets and original gameplay in a new editable project.</p>}
    {productions.length > 0 && <label className="creator-model">Saved game builds<select value={production?.id || ''} disabled={pending} onChange={event => {
      if (!event.target.value) { setProduction(null); setAssignments({}); setTaskAssignments({}); return; }
      perform(async () => { const value = await productionApi.get(event.target.value); setAssignments(value.models); setTaskAssignments(value.taskModels || {}); setConcurrency(value.concurrency); return value; });
    }}><option value="">New game idea</option>{productions.map(item => <option key={item.id} value={item.id}>{item.plan?.name || item.brief.slice(0, 45)}</option>)}</select></label>}
    {!production && <label className="creator-prompt">Your game idea<textarea rows={5} maxLength={6000} value={brief} disabled={pending} onChange={event => setBrief(event.target.value)}/></label>}
    <details className="production-team">
      <summary>Model team · {concurrency} parallel workers</summary>
      <p className="creator-help">Use any connected model for each role. Independent scenery and model jobs run together. Scene saves are coordinated. More workers can increase provider usage.</p>
      {ROLES.map(role => <label className="creator-model" key={role}>{LABELS[role]}<select disabled={busy} value={taskAssignments[role] ?? assignments[role] ?? model} onChange={event => {
        setAssignments(previous => ({ ...previous, [role]: event.target.value }));
        setTaskAssignments(previous => { const next = { ...previous }; delete next[role]; return next; });
      }}><option value="">Configured default</option>{models.map(entry => <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>)}</select></label>)}
      {!!plan?.assets.length && <details><summary>Choose a model for each asset</summary>{plan.assets.map(asset => {
        const id = `asset-${asset.id}`;
        return <label className="creator-model" key={id}>{asset.name}<select disabled={busy} value={taskAssignments[id] ?? '__inherit__'} onChange={event => setTaskAssignments(previous => {
          const next = { ...previous }; if (event.target.value === '__inherit__') delete next[id]; else next[id] = event.target.value; return next;
        })}><option value="__inherit__">Use 3D model builder</option><option value="">Configured default</option>{models.map(entry => <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>)}</select></label>;
      })}</details>}
      <label className="creator-model">Parallel workers<select disabled={busy} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))}>{[1, 2, 3, 4].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
    </details>
    {!production && <button type="button" className="creator-generate" disabled={pending || !brief.trim()} onClick={() => perform(() => productionApi.create({ brief, models: selectedModels, concurrency }))}>{pending ? 'Starting designer…' : 'Design my game'}</button>}
    {production && <>
      <p className="production-status" role="status">{production.status === 'ready' ? 'Playable build ready' : production.status === 'review' ? 'Design ready for review' : production.status === 'planning' ? 'Designing your game…' : production.status === 'building' ? 'Building your game…' : production.status === 'stopping' ? 'Stopping after active model calls settle…' : production.status === 'interrupted' ? 'Build interrupted — saved work is available' : production.status === 'stopped' ? 'Build stopped — saved work is available' : 'Build needs attention'}</p>
      {production.status === 'review' && <button type="button" className="creator-generate" disabled={pending || !draft} onClick={() => perform(() => productionApi.control(production.id, 'start', { revision: production.revision, plan: draft, models: selectedModels, taskModels: taskAssignments, concurrency }))}>Build this game</button>}
      {production.status === 'review' && <button type="button" disabled={pending || !draft} onClick={() => perform(() => productionApi.control(production.id, 'save', { revision: production.revision, plan: draft, models: selectedModels, taskModels: taskAssignments, concurrency }))}>Save design</button>}
      {['failed', 'stopped', 'interrupted'].includes(production.status) && production.error?.code !== 'REVISION_CONFLICT' && <button type="button" className="creator-generate" disabled={pending} onClick={() => perform(() => productionApi.control(production.id, 'resume', { revision: production.revision, models: selectedModels, taskModels: taskAssignments, concurrency }))}>Retry unfinished work</button>}
      {running(production) && <button type="button" disabled={pending || production.status === 'stopping'} onClick={() => perform(() => productionApi.control(production.id, 'stop', {}))}>Stop build</button>}
      {production.error && <p className="creator-error" role="alert">{production.error.message}</p>}
      {production.projectId && !running(production) && <button className="creator-generate" type="button" onClick={() => { openProject(production.projectId!); }}>Open editable game</button>}
      {production.build && <a className="creator-download" href={production.build.previewUrl} target="_blank" rel="noreferrer">Play saved build ↗</a>}
      {production.tasks.length > 0 && <ol className="production-streams" aria-label="AI build streams">{[...production.tasks].sort((a, b) => Number(b.status === 'running' || b.status === 'failed') - Number(a.status === 'running' || a.status === 'failed')).map(entry => <li key={entry.id} data-status={entry.status}><div><strong>{entry.name}</strong><span>{entry.status}</span></div><small>{entry.model || 'Configured default'}{entry.appliedRevision ? ` · saved r${entry.appliedRevision}` : ''}{entry.testResults ? ` · ${entry.testResults.passed} tests passed` : ''}</small>{entry.error && <p>{entry.error}</p>}</li>)}</ol>}
      {plan && <details className="production-plan" key={`${production.id}-${production.status === 'review'}`} open={production.status === 'review'}><summary>Game design · {plan.name}</summary><section aria-label="Game design">
        <h3>{plan.name}</h3><p>{plan.fantasy}</p><p className="creator-help">{plan.foundation === 'authored' ? 'Original world and game rules, built from an empty project.' : 'Expedition foundation with custom scenery and gameplay.'}</p>
        <ol>{plan.coreLoop.map((item, i) => <li key={i}>{item}</li>)}</ol>
        <p><strong>Win:</strong> {plan.winCondition}</p><p><strong>Restart:</strong> {plan.loseCondition}</p>
        <details><summary>Art, controls and planned assets</summary><p>{plan.artDirection}</p><ul>{plan.controls.map((item, i) => <li key={i}>{item}</li>)}</ul><ul>{plan.assets.map(asset => <li key={asset.id}>{asset.name} · {asset.placement}</li>)}</ul><p>{plan.gameplayPrompt}</p></details>
        {plan.deferred.length > 0 && <details><summary>Outside this build’s scope</summary><ul>{plan.deferred.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
        {production.status === 'review' && <GamePlanEditor plan={plan} disabled={pending} onChange={value => setPlanText(JSON.stringify(value, null, 2))}/>}
      </section></details>}
      {production.status === 'review' && <details open={!draft}><summary>Advanced game design JSON</summary><label className="creator-prompt">Game design JSON<textarea rows={12} disabled={pending} value={planText} onChange={event => setPlanText(event.target.value)} spellCheck={false}/></label>{!draft && <p className="creator-error" role="alert">The design must be a complete Lilly game plan. Correct the JSON to restore the editor and enable building.</p>}</details>}
      {plan && production.status === 'ready' && <details><summary>Your playtest checklist</summary><ul>{plan.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul></details>}
      {production.events.length > 0 && <details><summary>Build activity · {production.events.length} updates</summary><ol className="production-events">{production.events.slice(-40).map(event => <li key={event.sequence}><time>{new Date(event.at).toLocaleTimeString()}</time> {event.message}</li>)}</ol></details>}
      {!running(production) && <button type="button" disabled={pending} onClick={() => { setProduction(null); setAssignments({}); setTaskAssignments({}); setError(''); }}>New game idea</button>}
    </>}
    {error && <p className="creator-error" role="alert">{error}</p>}
    <p className="creator-help">Creates a playable browser game foundation. Generated models are stylized and static. Automated checks run before the build; use the playtest checklist to judge the game itself.</p>
  </div>;
}
