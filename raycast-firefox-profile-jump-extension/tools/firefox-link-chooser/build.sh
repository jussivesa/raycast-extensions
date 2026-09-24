#!/bin/sh
# Build Firefox Link Chooser and install it to ~/Applications.
set -eu

cd "$(dirname "$0")"
APP="$HOME/Applications/Firefox Link Chooser.app"
BUILD="build/Firefox Link Chooser.app"

rm -rf build
mkdir -p "$BUILD/Contents/MacOS"
cp Info.plist "$BUILD/Contents/Info.plist"
swiftc -O -framework AppKit -lsqlite3 main.swift -o "$BUILD/Contents/MacOS/FirefoxLinkChooser"
codesign --force --sign - "$BUILD"

mkdir -p "$HOME/Applications"
rm -rf "$APP"
cp -R "$BUILD" "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "Installed: $APP"
