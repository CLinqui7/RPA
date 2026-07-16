import fs from 'node:fs/promises';
import path from 'node:path';

function initialState() {
  return {
    version: 2,
    last_scanned_job_id: 0,
    groups: {},
    processed_job_ids: {},
    unmatched_jobs: {}
  };
}

export class PickTicketExpectationStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return initialState();
      throw error;
    }
  }

  async write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(temp, this.filePath);
  }

  async upsertGroup(group) {
    const state = await this.read();
    state.groups[group.group_key] = {
      ...state.groups[group.group_key],
      ...group,
      expected_pick_tickets: group.expected_pick_tickets,
      updated_at: new Date().toISOString()
    };
    await this.write(state);
    return state.groups[group.group_key];
  }
}
