{
  description = "Export public Logseq pages to Hugo, offline";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      mkSchrodinger =
        pkgs:
        pkgs.stdenvNoCC.mkDerivation {
          pname = "logseq-schrodinger";
          version = "1.3.2";
          src = ./.;
          nativeBuildInputs = [
            pkgs.esbuild
            pkgs.makeWrapper
          ];
          buildPhase = ''
            runHook preBuild
            esbuild src/cli/index.ts \
              --bundle --platform=node --format=esm \
              --outfile=cli.mjs
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            install -Dm644 cli.mjs $out/share/schrodinger/cli.mjs
            makeWrapper ${pkgs.nodejs}/bin/node $out/bin/schrodinger \
              --add-flags "$out/share/schrodinger/cli.mjs"
            runHook postInstall
          '';
          meta = {
            description = "Export public Logseq pages to Hugo without running Logseq";
            mainProgram = "schrodinger";
            license = pkgs.lib.licenses.mit;
            platforms = systems;
          };
        };
    in
    {
      packages = forAllSystems (pkgs: {
        default = mkSchrodinger pkgs;
        schrodinger = mkSchrodinger pkgs;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            nodejs
            esbuild
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
