"""Gestionale Hermes — agent-plugin registration.

Il lato agent non registra tool o hook per ora: la UI vive nel desktop half
(desktop-plugins/gestionale/plugin.js) e il backend vive in dashboard/plugin_api.py
montato dal web server su /api/plugins/gestionale/.

Espone register() no-op per soddisfare il loader agent di Hermes."""
def register(dm=None):
    return None
