import { useEffect, useMemo, useState } from 'react';
import { useStudioStore } from '../store';
import { Icon } from './Icon';
import { studioApi } from '../api';
import { ModelPreview } from './ModelPreview';
import { EnvironmentCreator } from './EnvironmentCreator';

const QUICK_IDEAS = [
  {
    label: 'Neon run',
    prompt: 'Build a compact neon ruin with six readable rooms, two fair guardian encounters, four enemies, glowing cores, checkpoints, and a strong exit beacon.',
  },
  {
    label: 'Forest temple',
    prompt: 'Create a calm verdant temple expedition with winding rooms, one guardian encounter, two enemies, a checkpoint, golden relics, and clear paths.',
  },
  {
    label: 'Frost escape',
    prompt: 'Make a challenging frozen vault with two locked combat rooms, four guardians, recovery checkpoints, and a final exit beacon.',
  },
  {
    label: 'Surprise me',
    prompt: 'Surprise me with a distinctive third-person action level, fair guardian encounters, readable checkpoints, a strong landmark, and a satisfying exit.',
  },
];

function randomSeed() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function pretty(value = '') {
  return value.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function LevelCreatorBody({ compact = false }: { compact?: boolean }) {
  const { current, aiRun, aiStatus, aiAssetId, refineAsset, proposeAi, applyAi, rejectAi, consoleItems } = useStudioStore();
  const [mode, setMode] = useState<'level' | 'asset' | 'edit' | 'environment'>(aiAssetId ? 'asset' : 'level');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name?: string }>>([]);
  const [modelError, setModelError] = useState('');
  const [prompt, setPrompt] = useState('A small exploration robot with a rounded teal body, chunky feet, copper joints, a glass-blue eye and a backpack antenna.');
  const loadModels = () => {
    setModelError('');
    studioApi.listModels().then((result) => {
      setModels(result.data);
      setModel((selected) => selected || (result.data.some((entry) => entry.id === 'gpt-6-astra') ? 'gpt-6-astra' : ''));
    }).catch(() => setModelError('Model list unavailable. Retry to choose Codex or Astra from your connected models.'));
  };
  useEffect(loadModels, []);
  useEffect(() => {
    if (aiAssetId) { setMode('asset'); setPrompt(''); }
  }, [aiAssetId]);
  const sourceAsset = current?.project.assets.find((entry) => entry.id === aiAssetId);
  const editableAssets = current?.project.assets.filter((entry) => entry.metadata?.sourcePath && current.project.files.some((file) => file.path === entry.metadata?.sourcePath)) || [];
  const busy = aiStatus === 'thinking' || aiStatus === 'applying';
  const proposal = aiRun?.mode === mode ? aiRun : null;
  const asset = proposal?.preview.asset;
  const error = [...consoleItems].reverse().find((entry) => entry.level === 'error')?.message;
  return <div className="creator-workflow">
    <div className="creator-mode" role="group" aria-label="What would you like to create?">
      {(['level', 'asset', 'environment', 'edit'] as const).map((value) => <button type="button" key={value} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); refineAsset(null); rejectAi(); setPrompt(value === 'asset' ? 'A small exploration robot with a rounded teal body, chunky feet, copper joints, a glass-blue eye and a backpack antenna.' : 'Improve the lighting and atmosphere of this scene.'); }}>{value === 'level' ? 'Game' : value === 'asset' ? '3D asset' : value === 'environment' ? 'Scenery' : 'Edit scene'}</button>)}
    </div>
    <label className="creator-model">AI model
      <select value={model} disabled={busy} onChange={(event) => { setModel(event.target.value); rejectAi(); }}>
        <option value="">Configured default</option>
        {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name || entry.id}</option>)}
      </select>
    </label>
    {modelError && <div className="creator-error" role="status"><span>{modelError}</span><button type="button" onClick={loadModels}>Retry model list</button></div>}
    {mode === 'level' ? <GameLevelBody compact={compact} model={model}/> : mode === 'environment' ? <EnvironmentCreator compact={compact} model={model}/> : <div className="level-creator">
      <div className="creator-intro"><div><span className="panel-kicker">{mode === 'asset' ? 'Real geometry · downloadable GLB' : 'Project-aware changes'}</span><strong>{mode === 'asset' ? sourceAsset ? `Refine ${sourceAsset.name}` : 'Describe your 3D asset' : 'What should change?'}</strong></div></div>
      {mode === 'asset' && editableAssets.length > 0 && <label className="creator-model">Create or refine<select value={aiAssetId || ''} disabled={busy} onChange={(event) => { refineAsset(event.target.value || null, false); setPrompt(''); }}><option value="">New 3D asset</option>{editableAssets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}{entry.metadata?.createdRevision ? ` · saved r${entry.metadata.createdRevision}` : entry.metadata?.refinedFrom ? ' · previous refinement' : ' · original'}</option>)}</select></label>}
      <p className="creator-help">{mode === 'asset' ? 'Create stylized props and models with materials. Rotate the preview, then add it to your game. Editable model source is saved with every asset.' : 'Ask for lighting, scene objects, or gameplay changes. Review the proposal before applying it.'}</p>
      <label className="creator-prompt">{sourceAsset && mode === 'asset' ? 'What should change?' : mode === 'asset' ? 'Shape, style, colors and details' : 'Your change'}<textarea value={prompt} placeholder={sourceAsset ? 'Give the robot longer arms and yellow armor. Keep its eye and backpack.' : ''} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={compact ? 3 : 4} disabled={busy}/></label>
      {mode === 'asset' && !sourceAsset && <div className="creator-ideas" aria-label="3D asset idea starters">{['A mossy stone arch with carved steps and golden crystal accents', 'A low-poly red spaceship with swept wings, twin engines and a blue cockpit', 'A stylized treasure chest with curved lid, gold bands and a chunky lock'].map((idea, i) => <button type="button" key={idea} disabled={busy} onClick={() => setPrompt(idea)}>{['Stone arch', 'Spaceship', 'Treasure chest'][i]}</button>)}</div>}
      <button type="button" className="creator-generate" disabled={busy || !prompt.trim()} onClick={() => proposeAi(prompt, { mode, model, requireAi: true, ...(mode === 'asset' && sourceAsset ? { assetId: sourceAsset.id } : {}) })}>{busy ? 'Creating…' : mode === 'asset' ? sourceAsset ? 'Preview refinement' : 'Generate 3D asset' : 'Propose changes'}</button>
      {aiStatus === 'error' && <div className="creator-error" role="alert">{error || 'Creation failed. Please retry.'}</div>}
      {proposal && <section className="level-proposal" aria-label={mode === 'asset' ? 'Generated model proposal' : 'Scene change proposal'}>
        <div className="proposal-heading"><strong>{asset?.name || 'Review scene changes'}</strong></div>
        {asset && <><ModelPreview url={studioApi.modelPreviewUrl(proposal.projectId, proposal.id)}/><div className="proposal-metrics"><span><strong>{asset.parts}</strong> parts</span><span><strong>{asset.triangles.toLocaleString()}</strong> triangles</span></div><p className="creator-help">{asset.size.map((n) => n.toFixed(1)).join(' × ')} m · {Math.ceil(asset.sizeBytes / 1024)} KB · GLB</p><a className="creator-download" href={studioApi.modelPreviewUrl(proposal.projectId, proposal.id)} download={`${asset.name}.glb`}>Download GLB</a></>}
        <p className="creator-help">Requested model: {proposal.generation?.requestedModel || 'configured default'}. {proposal.generation?.warning}</p>
        {proposal.refinement && <p className="creator-help">Updates {proposal.refinement.instances} scene instance{proposal.refinement.instances === 1 ? '' : 's'} of {proposal.refinement.name}. The previous GLB stays in your library. Undo restores the scene.</p>}
        {mode === 'edit' && <details open><summary>{proposal.commands.length} proposed changes</summary><pre>{JSON.stringify(proposal.commands, null, 2)}</pre></details>}
        <div className="proposal-actions"><button type="button" onClick={rejectAi} disabled={busy}>Discard</button><button type="button" className="primary-small" onClick={applyAi} disabled={busy || proposal.baseRevision !== current?.project.revision}>{aiStatus === 'applying' ? 'Saving…' : proposal.refinement ? 'Use refined model' : mode === 'asset' ? 'Add to scene' : 'Apply changes'}</button></div>
        {proposal.baseRevision !== current?.project.revision && <p role="status">Your project changed. Generate a fresh proposal before applying.</p>}
      </section>}
      {mode === 'asset' && <p className="creator-help">Best for stylized static assets. For sculpted or rigged characters, import a GLB from your modelling tool.</p>}
    </div>}
  </div>;
}

function GameLevelBody({ compact = false, model = '' }: { compact?: boolean; model?: string }) {
  const {
    current,
    aiRun,
    aiStatus,
    buildStatus,
    playState,
    proposeAi,
    applyAi,
    rejectAi,
    setPlayState,
    build,
    publish,
  } = useStudioStore();
  const savedRecipe = current?.project.levelRecipes?.find((recipe) => recipe.sceneId === current.project.entryScene) || null;
  const [prompt, setPrompt] = useState(savedRecipe?.prompt || QUICK_IDEAS[0].prompt);
  const [seed, setSeed] = useState('');

  useEffect(() => {
    setPrompt(savedRecipe?.prompt || QUICK_IDEAS[0].prompt);
    setSeed('');
  }, [current?.project.id]);

  const matchingBuild = useMemo(() => current?.builds.find((entry) => (
    entry.projectRevision === current.project.revision
    && ['success', 'published'].includes(entry.status)
  )) || null, [current]);
  const level = aiRun?.preview.level || null;
  const isThinking = aiStatus === 'thinking';

  const propose = (nextSeed = seed) => {
    if (!prompt.trim()) return;
    proposeAi(prompt.trim(), { mode: 'level', model, requireAi: true, ...(nextSeed ? { seed: nextSeed } : {}) });
  };

  return <div className={`level-creator${compact ? ' compact' : ''}`}>
    <div className="creator-intro">
      <div><span className="panel-kicker">AI game builder</span><strong>Describe the game you want</strong></div>
      {savedRecipe && <span className="creator-seed" title="Saved deterministic seed">seed {savedRecipe.seed}</span>}
    </div>
    <label className="creator-prompt" htmlFor={compact ? 'mobile-level-prompt' : 'level-prompt'}>
      <span>One idea is enough</span>
      <textarea
        id={compact ? 'mobile-level-prompt' : 'level-prompt'}
        value={prompt}
        onChange={(event) => { setPrompt(event.target.value); setSeed(''); }}
        rows={compact ? 2 : 4}
        placeholder="A mossy temple with two guardian encounters, three traps, checkpoints, and an exit high above the spawn..."
      />
    </label>
    <div className="creator-ideas" aria-label="Level idea starters">
      {QUICK_IDEAS.map((idea) => <button
        type="button"
        key={idea.label}
        onClick={() => { setPrompt(idea.prompt); setSeed(''); }}
      >{idea.label}</button>)}
    </div>
    <button
      className="creator-generate"
      type="button"
      onClick={() => propose()}
      disabled={!prompt.trim() || isThinking || aiStatus === 'applying'}
    >
      {isThinking ? <><span className="spinner-small"/>Directing a playable game...</> : <><Icon name="spark"/>Generate game</>}
    </button>

    {aiStatus === 'error' && <div className="creator-error" role="alert"><strong>That design could not be generated.</strong><span>{[...useStudioStore.getState().consoleItems].reverse().find((entry) => entry.level === 'error')?.message || 'Try a shorter description or another model.'}</span></div>}

    {level && aiRun && <section className="level-proposal" aria-label="Generated level proposal">
      <div className="proposal-heading">
        <div><span className="panel-kicker">Ready to apply</span><strong>{level.name}</strong></div>
        <span className="proposal-theme">{pretty(level.theme)}</span>
      </div>
      <p className="creator-help">{aiRun.generation?.warning || `Requested model: ${aiRun.generation?.requestedModel || 'configured default'}`}</p>
      <div className="proposal-metrics">
        <span><strong>{level.metrics.roomCount}</strong> rooms</span>
        <span><strong>{level.metrics.encounterCount}</strong> encounters</span>
        <span><strong>{level.metrics.enemyCount}</strong> guardians</span>
        <span><strong>{level.metrics.checkpointCount}</strong> checkpoints</span>
      </div>
      <div className="proposal-proof"><span>Route and encounter grammar valid</span><code>{level.checksum}</code></div>
      <div className="proposal-actions">
        <button type="button" onClick={() => {
          const nextSeed = randomSeed();
          setSeed(nextSeed);
          propose(nextSeed);
        }} disabled={isThinking}>Try another</button>
        <button type="button" className="primary-small" onClick={applyAi} disabled={aiStatus === 'applying' || isThinking || aiRun.baseRevision !== current?.project.revision}>
          {aiStatus === 'applying' ? 'Building world...' : 'Use this level'}
        </button>
      </div>
      {aiRun.baseRevision !== current?.project.revision && <p role="status">Your project changed. Generate a fresh proposal before applying.</p>}
      {!compact && <details className="proposal-details"><summary>Technical command</summary><pre>{JSON.stringify(aiRun.commands, null, 2)}</pre></details>}
      <button type="button" className="proposal-dismiss" onClick={rejectAi}>Discard proposal</button>
    </section>}

    <div className="creator-actions" aria-label="Game workflow actions">
      <button type="button" onClick={() => setPlayState(playState === 'playing' ? 'editing' : 'playing')}>
        <Icon name={playState === 'playing' ? 'close' : 'play'}/>{playState === 'playing' ? 'Edit' : 'Play'}
      </button>
      <button type="button" onClick={() => build()} disabled={buildStatus === 'building' || buildStatus === 'testing'}>
        <Icon name="build"/>{buildStatus === 'building' ? 'Building...' : 'Build'}
      </button>
      {matchingBuild && matchingBuild.status !== 'published' && <button type="button" onClick={() => publish(matchingBuild)} disabled={buildStatus === 'publishing'}>
        <Icon name="publish"/>{buildStatus === 'publishing' ? 'Publishing...' : 'Publish'}
      </button>}
      {matchingBuild?.status === 'published' && matchingBuild.publicUrl && <a href={matchingBuild.publicUrl} target="_blank" rel="noreferrer">Open live game</a>}
    </div>
  </div>;
}

export function MobileCreator() {
  const playState = useStudioStore((state) => state.playState);
  const [open, setOpen] = useState(true);
  if (playState !== 'editing') {
    return <div className="mobile-play-bar">
      <div><span className="status-dot"/><strong>Playing your game</strong></div>
      <button type="button" onClick={() => useStudioStore.getState().setPlayState('editing')}>Back to create</button>
    </div>;
  }
  return <aside className={`mobile-creator${open ? ' open' : ' collapsed'}`}>
    <button className="mobile-creator-handle" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      <span/><strong>{open ? 'Create with Lilly AI' : 'Describe and generate a level'}</strong><small>{open ? 'Hide' : 'Open'}</small>
    </button>
    {open && <LevelCreatorBody compact/>}
  </aside>;
}
