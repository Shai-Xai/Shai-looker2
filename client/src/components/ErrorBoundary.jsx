import { Component } from 'react';
import crashReport from '../lib/crashReport.js';

// Isolates render errors to a single tile instead of blanking the dashboard.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    crashReport(error, info); // tile crashes were invisible to the team before
  }
  componentDidUpdate(prev) {
    // Reset when the tile's data changes so a transient error can recover.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 12, textAlign: 'center' }}>
          <p style={{ color: 'var(--error)', fontSize: 11, lineHeight: 1.4 }}>
            ⚠ Couldn’t render this tile<br />
            <span style={{ color: '#bbb' }}>{String(this.state.error.message || this.state.error)}</span>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
