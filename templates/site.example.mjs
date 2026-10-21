// Example site policy for arc. Copy to ~/.config/arc/site.mjs and adapt to your cluster.
// The real file holds local accounts and limits: keep it out of version control.

// Parent directory for new campaigns (fast scratch storage, not your home directory).
export const runs_root = '/scratch/YOUR_USER/arc';

// PATH for agent turns and jobs: must contain node, git and the agent CLIs.
export const path = process.env.PATH;

// Cluster rules shown to the worker and the advisor in every prompt.
export const prompt = `
- Heavy computation belongs in jobs, not on the login node.
- GPU nodes have 8 GPUs; multi-node jobs use whole nodes.
- Use at most 12 CPUs per GPU.
`;

const GPU_PARTITION = 'gpu';
const CPU_PARTITION = 'cpu';
const ACCOUNT = 'your-account';
const GPUS_PER_NODE = 8;
const MAX_CPUS_PER_GPU = 12;

// Throw for shapes this cluster can never run. The request is rejected; the worker files a corrected one.
export function validate(r) {
  if (r.gpus > GPUS_PER_NODE && r.gpus % GPUS_PER_NODE) throw Error(`multi-node jobs must use whole nodes of ${GPUS_PER_NODE} GPUs`);
}

// Extra commands to block inside jobs (sbatch, salloc, scancel, scontrol are always blocked).
export function forbidden(r) {
  return r.gpus > GPUS_PER_NODE ? [] : ['srun']; // srun only inside multi-node jobs
}

// Turn a request into sbatch arguments, or {wait: reason} to hold it back this tick.
// The engine adds --hold, --parsable, --no-requeue, --job-name, --comment, --chdir and --output itself.
// ctx.exec(cmd, args) runs a command and returns stdout, e.g. to check a shared pool's live usage.
export function route(r, ctx) {
  const common = [`--account=${ACCOUNT}`, `--mem=${r.mem_gb}G`, `--time=${r.minutes}`];
  if (!r.gpus) {
    return {args: [`--partition=${r.partition ?? CPU_PARTITION}`, '--nodes=1', '--ntasks=1', `--cpus-per-task=${r.cpus}`, ...common], note: 'CPU job'};
  }
  if (r.gpus <= GPUS_PER_NODE) {
    const cpus = Math.min(r.cpus, MAX_CPUS_PER_GPU * r.gpus);
    return {args: [`--partition=${GPU_PARTITION}`, '--nodes=1', '--ntasks=1', `--cpus-per-task=${cpus}`, `--gres=gpu:${r.gpus}`, ...common],
      note: `single node, ${cpus} CPUs (requested ${r.cpus})`};
  }
  const nodes = r.gpus / GPUS_PER_NODE;
  const cpus = Math.min(r.cpus, MAX_CPUS_PER_GPU);
  return {args: [`--partition=${GPU_PARTITION}`, `--nodes=${nodes}`, `--ntasks=${r.gpus}`, `--ntasks-per-node=${GPUS_PER_NODE}`,
    `--cpus-per-task=${cpus}`, `--gres=gpu:${GPUS_PER_NODE}`, ...common], note: `${nodes} nodes, one task per GPU`};
}

// Example of a shared pool with a ceiling across all your campaigns, checked against live usage:
//
// function poolGpus(ctx, account) {
//   const rows = ctx.exec('squeue', ['-h', '-A', account, '--me', '-o', '%b|%D']).split('\n').filter(Boolean);
//   return rows.reduce((n, row) => { const [gres, nodes] = row.split('|'); const m = gres.match(/gpu(?::\w+)?[:=](\d+)/); return n + (m ? Number(m[1]) * Number(nodes) : 0); }, 0);
// }
// ... in route(): if (poolGpus(ctx, 'shared') + r.gpus > 64) return {wait: 'shared pool full'};
