import React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * Catches render-time errors so a crash degrades into a readable message instead of an
 * empty panel.
 *
 * React unmounts the entire tree when a render throws and no boundary catches it, and in
 * a side panel that presents as "the extension went black" with no clue why. The stack is
 * also printed to the console so the underlying error is still diagnosable.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Shown instead of the default copy, e.g. which panel failed. */
  label?: string;
  /** Rendered when the user resets, allowing a retry without reloading the extension. */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error(
      `[Keyboard Warriors]${this.props.label ? ` ${this.props.label}` : ''} crashed:`,
      error,
      info.componentStack
    );
  }

  handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center h-full w-full gap-3 p-6 text-center bg-gemini-bg text-white">
        <div className="w-11 h-11 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center">
          <AlertTriangle className="w-5 h-5 text-red-400" />
        </div>
        <div>
          <p className="text-sm font-semibold">
            {this.props.label || 'This panel'} stopped working
          </p>
          <p className="text-xs text-gemini-muted mt-1.5 max-w-xs leading-relaxed">
            A rendering error was caught instead of taking down the whole side panel. The
            details are in the side panel console.
          </p>
        </div>
        <pre className="max-w-full overflow-x-auto text-[10px] font-mono text-red-300/80 bg-red-950/30 border border-red-500/20 rounded px-2 py-1.5">
          {error.message}
        </pre>
        <button
          onClick={this.handleReset}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-gemini-blue hover:bg-gemini-blue/90 text-white transition-colors"
        >
          <RotateCw className="w-3.5 h-3.5" />
          <span>Try again</span>
        </button>
      </div>
    );
  }
}
