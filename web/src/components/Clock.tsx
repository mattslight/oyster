import { useEffect, useState } from "react";

export function Clock() {
  const [time, setTime] = useState(formatTime());

  useEffect(() => {
    const interval = setInterval(() => setTime(formatTime()), 10000);
    return () => clearInterval(interval);
  }, []);

  return <div className="surface-clock">{time}</div>;
}

function formatTime(): string {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
