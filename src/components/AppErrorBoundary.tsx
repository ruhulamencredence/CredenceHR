/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Catches an error while showing a page, so the app never turns into a blank
// white screen: a page that failed to download after a new version was
// deployed reloads once by itself; anything else shows a card with Try again
// / Reload (the house liquid-glass style).

import React from 'react';
import { isChunkLoadError, reloadForNewVersion } from '../lib/chunkReload';

interface State {
  error: Error | null;
}

export class AppErrorBoundary extends React.Component<{ children: React.ReactNode; resetKey?: unknown }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error)) reloadForNewVersion();
    console.error('Page error:', error);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    // Moving to another page clears the error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunk = isChunkLoadError(this.state.error);
    return (
      <div className="w-full min-h-[50vh] flex items-center justify-center px-4 py-10">
        <div className="liquid-glass liquid-glass-in rounded-[32px] max-w-sm w-full p-6 text-center">
          <div className="text-base font-bold text-slate-900">{chunk ? 'A new version is ready' : 'Something went wrong on this page'}</div>
          <p className="text-sm text-slate-600 mt-1.5">
            {chunk ? 'Reload to get the latest CredenceHR.' : 'Try again. If it keeps happening, reload the app.'}
          </p>
          <div className="flex items-center justify-center gap-2 mt-5">
            {!chunk && (
              <button type="button" onClick={() => this.setState({ error: null })} className="px-4 py-2 rounded-full text-sm text-slate-700 hover:bg-black/5">
                Try again
              </button>
            )}
            <button type="button" onClick={() => window.location.reload()} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-violet-600">
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
