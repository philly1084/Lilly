# Agent SDK Admin Dashboard

Interactive web dashboard for controlling and monitoring the OpenAI Agent SDK.

## Access

Once the server is running, access the dashboard at:
```
http://localhost:3000/admin/
```

Or from the homepage, click **"🎛️ Admin Dashboard"**.

## Features

### 📊 Overview
- Real-time statistics (tasks, success rate, sessions)
- Request volume charts
- Recent activity feed
- System health monitoring

### 📝 Prompts
- Manage system prompts and templates
- Live preview with variable injection
- Test prompts before deploying
- Version history tracking

### 🤖 Models
- Configure AI model settings
- Set default models
- View usage statistics
- Temperature, max tokens, etc.

### 📋 Logs
- Real-time request/response logs
- Filter by level, model, status
- Export to JSON/CSV
- Full request details

### 🎯 Skills
- Browse learned skills
- Enable/disable skills
- View usage statistics
- Search and filter

### 🔍 Traces
- Visual execution timeline
- Step-by-step analysis
- Performance metrics
- Export for debugging

### ⚙️ Settings
- Feature toggles
- API configuration
- Data retention
- Notification settings

## API Endpoints

The dashboard connects to these REST API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/stats` | GET | Dashboard statistics |
| `/api/admin/health` | GET | System health status |
| `/api/admin/activity` | GET | Recent activity |
| `/api/admin/prompts` | GET/POST | List/create prompts |
| `/api/admin/prompts/:id` | GET/PUT/DELETE | Manage prompt |
| `/api/admin/models` | GET | List models |
| `/api/admin/models/:id` | PUT | Update model config |
| `/api/admin/logs` | GET | View logs |
| `/api/admin/logs/stream` | GET | SSE log stream |
| `/api/admin/skills` | GET | List skills |
| `/api/admin/skills/:id` | PUT | Update skill |
| `/api/admin/traces` | GET | List traces |
| `/api/admin/settings` | GET/PUT | Manage settings |
| `/api/admin/sdk/execute` | POST | Execute task |
| `/api/admin/sdk/sessions` | GET | Active sessions |

## File Structure

```
frontend/agent-dashboard/
├── index.html              # Main dashboard HTML
├── css/
│   └── dashboard.css       # Styles
├── js/
│   ├── dashboard.js        # Main dashboard logic
│   └── api-client.js       # API client
└── README.md               # This file
```

## Integration

The dashboard is automatically served by the Express server at `/admin/` and connects to the Agent SDK backend via the `/api/admin/*` endpoints.

## Operations

Use the dashboard as a live operations view alongside the HTTP health endpoints. The Overview, Logs, Traces, and Health views help identify failed runtime tasks, repeated tool errors, slow requests, and degraded dependencies. The production monitoring and SLO runbook lives at `docs/monitoring-alerting-slo-runbook.md`.

## Development

To modify the dashboard:

1. Edit files in `frontend/agent-dashboard/`
2. Refresh the browser to see changes
3. No build step required (vanilla JS)

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+K` | Search |
| `Escape` | Close modals |
| `Ctrl+S` | Save (in editors) |
| `?` | Show help |
