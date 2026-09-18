import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Keeps one broken page from blanking the whole portal. Resets when `resetKey` (the route) changes. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Message and component stack only; never log request data or URLs with credentials.
    console.error('[crmex] page crashed:', error.message, info.componentStack?.split('\n').slice(0, 4).join('\n'));
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-8">
        <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border bg-card px-6 py-12 text-center">
          <AlertTriangle className="size-6 text-amber-600" />
          <div className="font-medium">Something went wrong on this page</div>
          <p className="max-w-md text-sm text-muted-foreground">Try again. If it keeps happening, reload the page.</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
            <Button onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </div>
      </div>
    );
  }
}
