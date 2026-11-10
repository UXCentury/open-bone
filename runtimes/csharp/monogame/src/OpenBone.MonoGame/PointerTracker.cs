using System.Collections.Generic;
using Microsoft.Xna.Framework;

namespace OpenBone.MonoGame
{
    /// <summary>A pointer event for the state machine: down, up or move, at a screen position.</summary>
    public struct PointerEvent
    {
        public string Type;
        public Vector2 Position;

        public PointerEvent(string type, Vector2 position)
        {
            Type = type;
            Position = position;
        }

        public override string ToString() => $"{Type} {Position}";
    }

    /// <summary>
    /// Turns per-frame pointer state (position, pressed) into OpenBone pointer events: <c>move</c> when the position
    /// changed, then <c>down</c> / <c>up</c> when the button state changed.
    /// </summary>
    public sealed class PointerTracker
    {
        bool _down, _seen;
        Vector2 _pos;

        public bool IsDown => _down;
        public Vector2 Position => _pos;

        public void Update(Vector2 position, bool pressed, List<PointerEvent> output)
        {
            if (!_seen || position != _pos)
            {
                _pos = position;
                output.Add(new PointerEvent("move", position));
            }
            _seen = true;
            if (pressed != _down)
            {
                _down = pressed;
                output.Add(new PointerEvent(pressed ? "down" : "up", position));
            }
        }

        /// <summary>Forget the state (e.g. when the window loses focus): a pressed pointer is released.</summary>
        public void Reset(List<PointerEvent> output)
        {
            if (_down) output?.Add(new PointerEvent("up", _pos));
            _down = false;
            _seen = false;
        }
    }
}
