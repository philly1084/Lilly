import { useEffect, useState } from 'react';
import { useStudioStore } from '../store';
import { studioApi } from '../api';
import { ModelPreview } from './ModelPreview';

const IDEAS = [
  { name: 'Forest', prompt: 'A peaceful woodland with rolling mossy hills, layered pine trees, clusters of ferns and weathered boulders. Warm morning light, pale mist, and open space around the game.' },
  { name: 'Desert', prompt: 'A sunlit red-rock desert with gentle dunes, layered sandstone formations, branching cacti and a ruined stone arch. Warm sand, blue sky and spacious paths.' },
  { name: 'Snow', prompt: 'A snowy alpine grove with low rolling hills, snow-capped fir trees, blue ice crystals and dark rocks. Cool blue shadows and soft winter sunlight.' },
];

export function EnvironmentCreator({ model, compact }: { model: string; compact: boolean }) {
  const { current, aiRun, aiStatus, proposeAi, applyAi, rejectAi, consoleItems } = useStudioStore();
  const [prompt, setPrompt] = useState(IDEAS[0].prompt);
  useEffect(() => setPrompt(IDEAS[0].prompt), [current?.project.id]);
  const busy = aiStatus === 'thinking' || aiStatus === 'applying';
  const proposal = aiRun?.mode === 'environment' ? aiRun : null;
  const environment = proposal?.preview.environment;
  const hasScenery = current?.project.files.some(file => file.path.endsWith('/scenery-recipe.json'));
  return <div className={`level-creator${compact ? ' compact' : ''}`}>
    <div className="creator-intro"><div><span className="panel-kicker">Terrain · scenery · atmosphere</span><strong>Describe your environment</strong></div></div>
    <p className="creator-help">Create rolling terrain and reusable 3D scenery around your game. Preview the landscape, then apply it in one step.</p>
    <label className="creator-prompt">Setting, plants, landmarks and mood<textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={compact ? 3 : 5} maxLength={4000} disabled={busy}/></label>
    <div className="creator-ideas" aria-label="Environment idea starters">{IDEAS.map(idea => <button key={idea.name} type="button" disabled={busy} onClick={() => setPrompt(idea.prompt)}>{idea.name}</button>)}</div>
    {hasScenery && <p className="creator-help">Your saved scenery guides follow-up requests. Applying replaces earlier Lilly scenery; Undo brings it back.</p>}
    <button className="creator-generate" type="button" disabled={busy || !prompt.trim()} onClick={() => proposeAi(prompt, { mode: 'environment', model, requireAi: true })}>{aiStatus === 'thinking' ? 'Creating landscape…' : 'Generate environment'}</button>
    {aiStatus === 'thinking' && <p className="creator-help" role="status">Designing terrain, models and placement. This can take a few minutes.</p>}
    {aiStatus === 'error' && <p className="creator-error" role="alert">{[...consoleItems].reverse().find(entry => entry.level === 'error')?.message || 'Creation failed. Please retry.'}</p>}
    {proposal && environment && <section className="level-proposal" aria-label="Generated environment proposal">
      <div className="proposal-heading"><strong>{environment.name}</strong></div>
      <ModelPreview url={studioApi.modelPreviewUrl(proposal.projectId, proposal.id)} sky={environment.sky}/>
      <div className="proposal-metrics"><span><strong>{environment.models}</strong> reusable models</span><span><strong>{environment.instances}</strong> scenery objects</span><span><strong>{environment.size.join(' × ')}</strong> meters</span></div>
      <p className="creator-help">Drag to rotate; scroll to zoom. Preview shows the new scenery. Existing game objects stay in place.</p>
      {environment.omitted > 0 && <p className="creator-help">{environment.omitted} requested objects were left out to avoid crowding or blocking existing objects.</p>}
      <p className="creator-help">Requested model: {proposal.generation?.requestedModel || 'configured default'}. Terrain, lighting and editable model sources are saved together.</p>
      <a className="creator-download" href={studioApi.modelPreviewUrl(proposal.projectId, proposal.id)} download={`${environment.name}.glb`}>Download scenery GLB</a>
      <div className="proposal-actions"><button type="button" disabled={busy} onClick={rejectAi}>Discard</button><button className="primary-small" type="button" disabled={busy || proposal.baseRevision !== current?.project.revision} onClick={applyAi}>{aiStatus === 'applying' ? 'Saving…' : 'Apply environment'}</button></div>
      {proposal.baseRevision !== current?.project.revision && <p role="status">Your project changed. Generate a fresh proposal before applying.</p>}
    </section>}
    <p className="creator-help">Best for stylized outdoor scenery. Terrain supports walking; decorative props have no solid collision.</p>
  </div>;
}
