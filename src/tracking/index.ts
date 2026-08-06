import { HRMSLocationTracker } from './HRMSLocationTracker';

// Module-level singleton — lives outside the React tree so GPS callbacks that
// fire after unmount or after an app-kill resume never reference a stale instance.
export const hrmsTracker = new HRMSLocationTracker();

export { HRMSLocationTracker };
export * from './types';
