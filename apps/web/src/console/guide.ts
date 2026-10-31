import type { ChannelView, ControllerStatus } from '@ripple/contracts';

export type StepState = 'done' | 'next' | 'todo' | 'optional' | 'locked';

/** One chapter of a console page, with its state derived from real server or session data. */
export interface GuideStep {
  readonly id: string;
  /** The id of the page section this step lives in. */
  readonly target: string;
  readonly title: string;
  readonly detail: string;
  readonly state: StepState;
}

/** Tour stops reference sections by id; stops whose section is not rendered are skipped. */
export interface TourStop {
  readonly target: string;
  readonly title: string;
  readonly body: string;
}

interface Draft {
  readonly id: string;
  readonly target: string;
  readonly title: string;
  readonly detail: string;
  /** null marks an optional step that never blocks the next one. */
  readonly done: boolean | null;
}

/** The first unfinished required step is next; later ones wait, or stay locked without access. */
export function sequence(drafts: readonly Draft[], locked = false): GuideStep[] {
  let foundNext = false;
  return drafts.map(({ done, ...step }) => {
    if (done === null) return { ...step, state: locked ? 'locked' : 'optional' };
    if (done) return { ...step, state: 'done' };
    if (locked) return { ...step, state: 'locked' };
    if (foundNext) return { ...step, state: 'todo' };
    foundNext = true;
    return { ...step, state: 'next' };
  });
}

export function nextStep(steps: readonly GuideStep[]): GuideStep | null {
  return steps.find((step) => step.state === 'next') ?? null;
}

export function controllerGuide(
  enabled: boolean | null,
  status: ControllerStatus | null,
): GuideStep[] {
  const channel = status?.snapshot?.payload ?? null;
  const drafts: Draft[] = [
    {
      id: 'connect',
      target: 'connect',
      title: 'Connect Twitch',
      detail:
        enabled === false
          ? 'Live Twitch is turned off on this installation. Try the sandbox instead.'
          : 'Sign in with the broadcaster account that will host the strain.',
      done: status !== null,
    },
    {
      id: 'bot',
      target: 'connect',
      title: 'Authorize the chat bot',
      detail: 'The operator authorizes one bot that reads !ripple votes in chat.',
      done: status?.botAuthorized ?? false,
    },
    {
      id: 'events',
      target: 'connect',
      title: 'Verify Twitch events',
      detail:
        'Twitch confirms its callback and subscriptions. This page re-checks every few seconds.',
      done: status !== null && status.callbackReady && status.subscriptionsReady,
    },
    {
      id: 'seed',
      target: 'strain',
      title: 'Seed your strain',
      detail: 'Type a name and press Seed strain. Chat then votes with !ripple 1, 2 or 3.',
      done: channel !== null && channel.organism !== null,
    },
    {
      id: 'overlay',
      target: 'stream',
      title: 'Put it on stream',
      detail:
        'Create a private link and paste the OBS URL into a 1920×1080 browser source. Done once the overlay connects.',
      done: (status?.readClients ?? 0) > 0,
    },
    {
      id: 'visitors',
      target: 'visitors',
      title: 'Decide who may visit',
      detail: 'Choose whether raided-in visitors are asked about, accepted or turned away.',
      done: null,
    },
    {
      id: 'studio',
      target: 'studio',
      title: 'Open a studio break',
      detail: 'Let viewers shape the next shell with their hands, then approve a finalist.',
      done: null,
    },
    {
      id: 'mechanics',
      target: 'mechanics',
      title: 'Tune habitat traces',
      detail: 'Optional mechanics that let surviving visitors leave a temporary mark.',
      done: null,
    },
  ];
  // Without live mode nothing here can be done; signing in is otherwise always the first step.
  return sequence(drafts, enabled === false);
}

export const controllerTour: readonly TourStop[] = [
  {
    target: 'guide-rail',
    title: 'Your map',
    body: 'Every chapter of the console is listed here. A filled mark means done, the bright one is what to do now, and dashed ones are optional.',
  },
  {
    target: 'next-step',
    title: 'Up next',
    body: 'This card always names the single next thing to do. Press Show me and the page scrolls straight to it.',
  },
  {
    target: 'connect',
    title: '1 · Connect',
    body: 'Sign in with Twitch. The bot and Twitch event checks then complete on their own; you only wait for the marks to fill.',
  },
  {
    target: 'strain',
    title: '2 · Your strain',
    body: 'Give the strain a name and press Seed strain. From then on chat votes with !ripple 1, 2 or 3 to choose each mutation.',
  },
  {
    target: 'visitors',
    title: '3 · Visitors and raids',
    body: 'When you raid, a descendant travels with your viewers. Here you decide how visitors raided into your channel are treated.',
  },
  {
    target: 'stream',
    title: '4 · On stream',
    body: 'Create a private preview link. Copy the OBS URL into a browser source and the creature appears over your stream.',
  },
  {
    target: 'studio',
    title: '5 · Cocoon Studio',
    body: 'During a break, viewers sculpt the next shell with their hands. You approve the community’s favourite before it hatches.',
  },
  {
    target: 'mechanics',
    title: '6 · Habitat traces',
    body: 'Optional rules that let a surviving visitor leave a fading mark on your channel. Turn them on when you are ready.',
  },
];

export type SandboxMilestone =
  'voted' | 'observed' | 'raided' | 'proposed' | 'approved' | 'replayed';

export function sandboxGuide(
  started: boolean,
  milestones: ReadonlySet<SandboxMilestone>,
): GuideStep[] {
  const drafts: Draft[] = [
    {
      id: 'start',
      target: 'expedition',
      title: 'Start your world',
      detail: 'Press Start my sandbox. No account is needed and nothing reaches Twitch.',
      done: started,
    },
    {
      id: 'mutate',
      target: 'controls',
      title: 'Choose a mutation',
      detail: 'Cast a synthetic vote, then press Next scheduled step to close the ballot.',
      done: milestones.has('voted'),
    },
    {
      id: 'observe',
      target: 'controls',
      title: 'Shape the habitat',
      detail: 'Add local chat or change habitat, then advance to see how the strain fared.',
      done: milestones.has('observed'),
    },
    {
      id: 'raid',
      target: 'controls',
      title: 'Send a raid',
      detail: 'Simulate a raid, switch to the neighbor and advance to its welcome vote.',
      done: milestones.has('raided'),
    },
    {
      id: 'studio',
      target: 'studio-controls',
      title: 'Build a shell',
      detail: 'Switch home, start a break studio and submit a design by hand or pointer.',
      done: milestones.has('proposed'),
    },
    {
      id: 'approve',
      target: 'studio-controls',
      title: 'Approve and hatch',
      detail: 'Vote for the design, advance to review and approve it, then advance to hatch.',
      done: milestones.has('approved'),
    },
    {
      id: 'replay',
      target: 'replay',
      title: 'Verify the replay',
      detail: 'Replay the accepted history and confirm every channel matches.',
      done: milestones.has('replayed'),
    },
  ];
  return sequence(drafts);
}

/** Which milestone a successful synthetic action completes, if any. */
export function milestoneFor(
  action: string,
  channel: Pick<ChannelView, 'round'> | null,
): SandboxMilestone | null {
  switch (action) {
    case 'vote':
      return 'voted';
    case 'chat':
    case 'shock':
      return channel?.round?.phase === 'OBSERVING' ? 'observed' : null;
    case 'raid':
      return 'raided';
    case 'propose':
      return 'proposed';
    case 'review':
      return 'approved';
    case 'replay':
      return 'replayed';
    default:
      return null;
  }
}

export const sandboxTour: readonly TourStop[] = [
  {
    target: 'guide-rail',
    title: 'Your expedition map',
    body: 'Seven chapters take you from a first mutation to a verified replay. Each one fills in as you actually do it.',
  },
  {
    target: 'next-step',
    title: 'Up next',
    body: 'This card always tells you the next button to press. Show me scrolls to it.',
  },
  {
    target: 'expedition',
    title: 'A private, synthetic world',
    body: 'Everything here is simulated in an isolated world that expires after 24 hours. Time only moves when you press Next scheduled step.',
  },
  {
    target: 'controls',
    title: 'The game clock and chat',
    body: 'Advance the clock, add simulated chat, change the habitat, or send a raid to the neighbor channel.',
  },
  {
    target: 'votes',
    title: 'Votes',
    body: 'One synthetic judge plus three simulated accounts vote for the choice you pick on the ballot.',
  },
  {
    target: 'studio-controls',
    title: 'Studio break',
    body: 'Open a break studio, sculpt a shell below, then approve the community design in review.',
  },
  {
    target: 'channel',
    title: 'The living channel',
    body: 'The creature, its energy and the current round update here after every step.',
  },
  {
    target: 'replay',
    title: 'Prove it',
    body: 'Replay rebuilds the whole expedition from accepted records and checks it matches exactly.',
  },
];
