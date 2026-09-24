#!/bin/bash
set -euo pipefail
workspace="${1:-$HOME/Developer/mobile-portfolio-20260923}"
mkdir -p "$workspace"
cd "$workspace"
clone_app() {
  local repo="$1" folder="$2"
  if [ -e "$folder" ]; then
    echo "Existing path: $workspace/$folder. Stopping to preserve your work; choose a fresh destination." >&2
    exit 1
  fi
  git clone --depth 1 --single-branch --branch codex/mac-handoff-20260923 "https://github.com/$repo.git" "$folder"
}
clone_app "castleism/Literally-Even" "literally-even"
clone_app "castleism/being-tea-co" "tea"
clone_app "castleism/SmileToYourBody" "smile"
clone_app "castleism/AwareOfMyFood" "aware"
clone_app "castleism/nooyouniverse" "noo"
clone_app "castleism/JustRightSpeech" "communication"
clone_app "castleism/Terraseeds" "terraseeds"
clone_app "castleism/MyPersonas" "personas"
clone_app "castleism/aliaspaces.com" "aliaspaces"
clone_app "castleism/Wonder-Notes" "wonder"
clone_app "castleism/Brick-by-Brick" "brick"
clone_app "castleism/AlwaysCookedJustRight" "cooked"
printf "All twelve repositories cloned into %s\n" "$workspace"
