@echo off
cd /d C:\Users\msawa\OneDrive\Desktop\StackPilot
"C:\Program Files\nodejs\node.exe" scripts\local-stock-monitor.mjs 250 --apply-purge >> scripts\receipts\local-monitor.log 2>&1
