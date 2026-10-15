import { useRef, useState } from "react";

interface Props {
  target: string | undefined;
  onFile: (file: File) => void;
}

/** Click or drop a captured .bin to print it on the selected printer. */
export function DropZone({ target, onFile }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`drop${over ? " over" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <strong>Drop a .bin file</strong>
      <span>to print it on {target ?? "the selected printer"}</span>
      <input
        ref={input}
        type="file"
        accept=".bin,.prn,application/octet-stream"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
