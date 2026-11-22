@echo off
title SSH setup + push — RagChatBot
cd /d "%~dp0"

echo ============================================================
echo  Step 1: SSH key (skipped automatically if you have one)
echo ============================================================
if not exist "%USERPROFILE%\.ssh\id_ed25519.pub" (
  ssh-keygen -t ed25519 -C "shubhambhattacharya107@gmail.com" -f "%USERPROFILE%\.ssh\id_ed25519" -N ""
) else (
  echo Key already exists — reusing it.
)

echo.
echo ============================================================
echo  Step 2: COPY the single line below (right-click = copy in this window)
echo  and paste it into the GitHub page that is about to open.
echo ============================================================
type "%USERPROFILE%\.ssh\id_ed25519.pub"
echo ============================================================
start "" "https://github.com/settings/ssh/new"
echo.
echo   On GitHub: 1) paste the key in the "Key" box
echo              2) click "Add SSH key"
echo   Then come back here and press any key to continue...
pause >nul

echo.
echo ============================================================
echo  Step 3: testing the GitHub connection
echo  (expected: "Hi shubhambhattacharya-dev!")
echo ============================================================
ssh -T -o StrictHostKeyChecking=accept-new git@github.com
echo.

echo ============================================================
echo  Step 4: pushing your commits
echo ============================================================
git push origin chore/project-setup
echo.
echo If the push succeeded and Render watches the "main" branch, also run:
echo   git push origin chore/project-setup:main
echo.
pause
