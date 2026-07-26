/**
 * orion code - Skills Discovery
 *
 * 自动发现和热重载机制
 */

import { getSkillsRegistry } from './registry';
import type { SkillDefinition } from './types';

// ============================================================================
// Discovery Service
// ============================================================================

export class SkillsDiscovery {
  private registry: ReturnType<typeof getSkillsRegistry>;
  private discoveryInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.registry = getSkillsRegistry();
  }

  /** Start periodic discovery */
  startPeriodicDiscovery(intervalMs: number = 60000): void {
    if (this.discoveryInterval) {
      this.stopPeriodicDiscovery();
    }

    this.discoveryInterval = setInterval(() => {
      this.discover();
    }, intervalMs);
  }

  /** Stop periodic discovery */
  stopPeriodicDiscovery(): void {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }

  /** Discover new skills */
  discover(): SkillDefinition[] {
    // Reload skills from loader
    const { getSkillsLoader } = require('./loader');
    const loader = getSkillsLoader();
    const newSkills = loader.load();

    console.log(`[SkillsDiscovery] Discovered ${newSkills.length} skills`);
    return newSkills;
  }

  /** Check for skill updates */
  checkForUpdates(): boolean {
    const { getSkillsLoader } = require('./loader');
    const loader = getSkillsLoader();
    const lastScan = loader.getLastScan();

    // If more than 5 minutes since last scan, reload
    if (Date.now() - lastScan > 5 * 60 * 1000) {
      this.discover();
      return true;
    }

    return false;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultDiscovery: SkillsDiscovery | null = null;

export function getSkillsDiscovery(): SkillsDiscovery {
  if (!defaultDiscovery) {
    defaultDiscovery = new SkillsDiscovery();
  }
  return defaultDiscovery;
}

export function resetSkillsDiscovery(): void {
  if (defaultDiscovery) {
    defaultDiscovery.stopPeriodicDiscovery();
  }
  defaultDiscovery = null;
}