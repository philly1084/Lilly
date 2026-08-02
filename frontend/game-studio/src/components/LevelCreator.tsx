import { useEffect, useMemo, useState } from 'react';
import { useStudioStore } from '../store';
import { Icon } from './Icon';

const QUICK_IDEAS = [
  {
    label: 'Neon run',
    prompt: 'Build a compact neon ruin with six readable rooms, glowing cores, two memorable landmarks, and a balanced set of pulse traps.',
  },
  {
    label: 'Forest temple',
    prompt: 'Create a calm verdant temple expedition with winding rooms, golden relics, clear paths, and only a few gentle hazards.',
  },
  {
    label: 'Frost escape',
    prompt: 'Make a challenging frozen vault where the player races through a long route to reach the exit beacon.',
  },
  {
    label: 'Surprise me',
    prompt: 'Surprise me with a distinctive, readable third-person level with a strong landmark, a fair challenge curve, and a satisfying exit.',
  },
];

function randomSeed() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function pretty(value = '') {
  return value.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function LevelCreatorBody({ compact = false }: { compact?: boolean }) {
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
    proposeAi(prompt.trim(), { mode: 'level', ...(nextSeed ? { seed: nextSeed } : {}) });
  };

  return <div className={`level-creator${compact ? ' compact' : ''}`}>
    <div className="creator-intro">
      <div><span className="panel-kicker">AI level builder</span><strong>Describe the game space</strong></div>
      {savedRecipe && <span className="creator-seed" title="Saved deterministic seed">seed {savedRecipe.seed}</span>}
    </div>
    <label className="creator-prompt" htmlFor={compact ? 'mobile-level-prompt' : 'level-prompt'}>
      <span>One idea is enough</span>
      <textarea
        id={compact ? 'mobile-level-prompt' : 'level-prompt'}
        value={prompt}
        onChange={(event) => { setPrompt(event.target.value); setSeed(''); }}
        rows={compact ? 2 : 4}
        placeholder="A mossy temple with a winding route, three traps, and an exit high above the spawn..."
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
      {isThinking ? <><span className="spinner-small"/>Designing a playable route...</> : <><Icon name="spark"/>Generate level</>}
    </button>

    {aiStatus === 'error' && <div className="creator-error"><strong>That design could not be generated.</strong><span>Try a shorter description or open Console for the validation message.</span></div>}

    {level && aiRun && <section className="level-proposal" aria-label="Generated level proposal">
      <div className="proposal-heading">
        <div><span className="panel-kicker">Ready to apply</span><strong>{level.name}</strong></div>
        <span className="proposal-theme">{pretty(level.theme)}</span>
      </div>
      <div className="proposal-metrics">
        <span><strong>{level.metrics.roomCount}</strong> rooms</span>
        <span><strong>{level.metrics.pickupCount}</strong> cores</span>
        <span><strong>{level.metrics.hazardCount}</strong> hazards</span>
        <span><strong>{level.metrics.landmarkCount}</strong> landmarks</span>
      </div>
      <div className="proposal-proof"><span>Spawn-to-exit path valid</span><code>{level.checksum}</code></div>
      <div className="proposal-actions">
        <button type="button" onClick={() => {
          const nextSeed = randomSeed();
          setSeed(nextSeed);
          propose(nextSeed);
        }} disabled={isThinking}>Try another</button>
        <button type="button" className="primary-small" onClick={applyAi} disabled={aiStatus === 'applying'}>
          {aiStatus === 'applying' ? 'Building world...' : 'Use this level'}
        </button>
      </div>
      {!compact && <details className="proposal-details"><summary>Technical command</summary><pre>{JSON.stringify(aiRun.commands, null, 2)}</pre></details>}
      <button type="button" className="proposal-dismiss" onClick={rejectAi}>Discard proposal</button>
    </section>}

    <div className="creator-actions" aria-label="Game workflow actions">
      <button type="button" onClick={() => setPlayState(playState === 'playing' ? 'editing' : 'playing')}>
        <Icon name={playState === 'playing' ? 'close' : 'play'}/>{playState === 'playing' ? 'Edit' : 'Play'}
      </button>
      <button type="button" onClick={build} disabled={buildStatus === 'building' || buildStatus === 'testing'}>
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
      <div><span className="status-dot"/><strong>Playing generated level</strong></div>
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
