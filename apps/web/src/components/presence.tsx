"use client";

import { Avatar } from "./avatar";
import { useWatching } from "./live";

/**
 * Who else is on this task, right now.
 *
 * Reads the people the live stream is pushing rather than anything the page
 * loaded (D-092): presence is not a property of the task, it is a property of
 * the moment, and a server render of it would be wrong by the time it arrived.
 *
 * Renders nothing when nobody else is here, which is most of the time. An empty
 * row that says "nobody else is looking at this" is a sentence the screen does
 * not need — the absence is the message.
 */
export function Presence() {
  const people = useWatching();
  if (people.length === 0) return null;

  return (
    <span
      className="presence"
      title={`${people.map((person) => person.name).join(", ")} ${
        people.length === 1 ? "is" : "are"
      } looking at this now`}
    >
      <span className="presence-live" />
      <span className="avatars">
        {people.map((person) => (
          <Avatar key={person.id} name={person.name} />
        ))}
      </span>
    </span>
  );
}
