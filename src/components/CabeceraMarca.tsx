import Image from "next/image";

export function CabeceraMarca({ titulo, subtitulo }: { titulo: string; subtitulo?: string }) {
  return (
    <header className="cabecera-marca">
      <Image
        src="/brand/fitnessland-logo.png"
        alt="Fitness Land · Health & Sport Center"
        width={345}
        height={217}
        priority
        className="cabecera-logo"
      />
      <div>
        <h1 className="cabecera-titulo">{titulo}</h1>
        {subtitulo ? <p className="sub">{subtitulo}</p> : null}
      </div>
    </header>
  );
}
