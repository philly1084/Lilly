import type { GamePlan } from './GameProduction';

// Guard advanced edits before rendering lists or sending a build request.
export function readGamePlan(text: string): GamePlan | null {
  try {
    const plan = JSON.parse(text);
    if (!plan || plan.schema !== 'LillyGamePlan/v1') return null;
    if (!['name', 'fantasy', 'artDirection', 'winCondition', 'loseCondition', 'levelPrompt', 'gameplayPrompt'].every(key => typeof plan[key] === 'string')) return null;
    if (!['coreLoop', 'controls', 'acceptance', 'deferred'].every(key => Array.isArray(plan[key]) && plan[key].every((item: unknown) => typeof item === 'string'))) return null;
    if (!Array.isArray(plan.assets) || !plan.assets.every((asset: Record<string, unknown> | null) => asset && ['id', 'name', 'prompt', 'placement'].every(key => typeof asset[key] === 'string'))) return null;
    if (plan.environmentPrompt !== null && typeof plan.environmentPrompt !== 'string') return null;
    if (plan.scenePrompt !== undefined && typeof plan.scenePrompt !== 'string') return null;
    return plan;
  } catch { return null; }
}

export function GamePlanEditor({ plan, onChange, disabled }: { plan: GamePlan; onChange: (plan: GamePlan) => void; disabled: boolean }) {
  const field = (key: 'name' | 'fantasy' | 'artDirection' | 'winCondition' | 'loseCondition' | 'levelPrompt' | 'scenePrompt' | 'gameplayPrompt', label: string, maxLength = 2000) => <label className="creator-prompt" key={key}>{label}<textarea rows={key === 'name' ? 1 : 3} maxLength={maxLength} value={plan[key] || ''} onChange={event => onChange({ ...plan, [key]: event.target.value })}/></label>;
  const list = (key: 'coreLoop' | 'controls' | 'acceptance' | 'deferred', label: string) => <label className="creator-prompt" key={key}>{label} · one per line<textarea rows={3} value={plan[key].join('\n')} onChange={event => onChange({ ...plan, [key]: event.target.value === '' ? [] : event.target.value.split('\n') })}/></label>;
  return <fieldset disabled={disabled} className="production-design-fields">
    <legend>Edit your game design</legend>
    <p className="creator-help">These instructions go to your model team when you build. Keep the rules and builder instructions consistent.</p>
    {field('name', 'Game name', 100)}
    {field('fantasy', 'Player experience')}
    {list('coreLoop', 'What the player does')}
    {field('winCondition', 'How to win', 500)}
    {field('loseCondition', 'How to lose and restart', 500)}
    {list('controls', 'Controls')}
    <details><summary>World and art direction</summary>
      {field('artDirection', 'Visual style')}
      {field(plan.foundation === 'authored' ? 'scenePrompt' : 'levelPrompt', 'Level builder instructions')}
      <label className="creator-prompt">Scenery builder instructions<textarea rows={3} maxLength={2000} value={plan.environmentPrompt || ''} onChange={event => onChange({ ...plan, environmentPrompt: event.target.value || null })}/></label>
    </details>
    <details><summary>3D asset briefs · {plan.assets.length}</summary>{plan.assets.map((asset, index) => <div key={asset.id}>
      <label className="creator-prompt">Asset {index + 1} name<textarea rows={1} maxLength={100} value={asset.name} onChange={event => onChange({ ...plan, assets: plan.assets.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })}/></label>
      <label className="creator-prompt">Asset {index + 1} appearance<textarea rows={3} maxLength={2000} value={asset.prompt} onChange={event => onChange({ ...plan, assets: plan.assets.map((item, i) => i === index ? { ...item, prompt: event.target.value } : item) })}/></label>
    </div>)}</details>
    <details><summary>Game rules and playtest checks</summary>
      {field('gameplayPrompt', 'Gameplay builder instructions')}
      {list('acceptance', 'Playtest checklist')}
      {list('deferred', 'Outside this build’s scope')}
    </details>
  </fieldset>;
}
