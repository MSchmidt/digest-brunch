const crypto  = require('crypto');
const fs      = require('fs');
const pathlib = require('path');
const glob    = require('glob');
const toposort = require('toposort');

const LEADING_SLASH_RE = /^\//;

const warn = message => Digest.logger.warn(`digest-brunch WARNING: ${message}`);

class Digest {
  static initClass() {
    this.prototype.brunchPlugin = true;
  }

  constructor(config) {
    // Defaults options
    this.config = config;
    this.options = {
      // A RegExp where the first subgroup matches the filename to be replaced
      pattern: /DIGEST\((\/?[^\)]*)\)/g,
      // After replacing the filename, should we discard the non-filename parts of the pattern?
      discardNonFilenamePatternParts: true,
      // RegExp that matches files that contain filename references.
      referenceFiles: /\.html$/,
      // How many digits of the SHA1 to append to digested files.
      precision: 8,
      // Force digest-brunch to run in all environments when true.
      alwaysRun: false,
      // Run in specific environments
      environments: ['production'],
      // Prepend an absolute asset host URL to the file paths in the reference files
      prependHost: null,
      // Output filename for a JSON manifest of reference file paths and their digest.
      manifest: '',
      // An array of infixes for alternate versions of files. This is useful when e.g. using retina.js (@2x) for high density images.
      infixes: []
    };

    // Merge config
    const cfg = (this.config.plugins != null ? this.config.plugins.digest : undefined) != null ? (this.config.plugins != null ? this.config.plugins.digest : undefined) : {};
    for (let k in cfg) { this.options[k] = cfg[k]; }

    // Ensure that the pattern RegExp is global
    const needle = this.options.pattern.source || this.options.pattern || '';
    let flags = 'g';
    if (this.options.pattern.ignoreCase) { flags += 'i'; }
    if (this.options.pattern.multiline) { flags += 'm'; }
    this.options.pattern = new RegExp(needle, flags);
  }

  onCompile() {
    this.publicFolder = this.config.paths.public;
    const filesToSearch = this._referenceFiles();

    // Check if the current environment is one we want to add digests for
    if ((!Array.from(this.options.environments).includes(this.config.env[0])) && !this.options.alwaysRun) {
      // Replace filename references with regular file name if not running.
      return this._removeReferences(filesToSearch);
    } else {
      if (this.config.server != null ? this.config.server.run : undefined) {
        warn('Not intended to be run with on-demand compilation (brunch watch)');
      }

      if (this.options.precision < 6) {
        warn('Name collision more likely when less than 6 digits of SHA used.');
      }

      const sortedFilesToSearch = this._sortByDependencyGraph(filesToSearch);
      const replacementDigestMap = {};
      for (let file of Array.from(sortedFilesToSearch)) {
        this._replaceFileDigests(file, replacementDigestMap);
      }

      return this._writeManifestFile(replacementDigestMap);
    }
  }

  _removeReferences(files) {
    if (!this.options.discardNonFilenamePatternParts) { return; }
    return (() => {
      const result = [];
      for (let file of Array.from(files)) {
        let contents = fs.readFileSync(file).toString();
        contents = contents.replace(this.options.pattern, '$1');
        result.push(fs.writeFileSync(file, contents));
      }
      return result;
    })();
  }

  // All files matching the `referenceFiles` regexp.
  // These are the target search and replace files.
  _referenceFiles() {
    const allUrls = glob.sync('**', { cwd: this.publicFolder });
    const referenceFiles = [];
    for (let url of Array.from(allUrls)) {
      const file = this._fileFromUrl(url);
      if (this.options.referenceFiles.test(file)) { referenceFiles.push(file); }
    }
    return referenceFiles;
  }

  // Because dependencies may contain other dependencies,
  // we will proceed in order of increasing dependency.
  _sortByDependencyGraph(files) {
    const graph = [];
    for (let file of Array.from(files)) {
      // Reset the pattern's internal match tracker
      this.options.pattern.lastIndex = 0;
      const contents = fs.readFileSync(file, 'UTF-8');
      let match = this.options.pattern.exec(contents);
      while (match !== null) {
        const url = match[1];
        const dependency = this._fileFromUrl(url, file);
        graph.push([dependency, file]);
        match = this.options.pattern.exec(contents);
      }
    }
    const sorted = toposort(graph);
    return sorted.filter(file => files.indexOf(file) >= 0);
  }

  // The filename a digest url should map to.
  _fileFromUrl(url, referencedFrom) {
    let dir;
    if (referencedFrom && (url[0] !== '/')) {
      dir = pathlib.dirname(referencedFrom);
    } else {
      dir = this.publicFolder;
    }
    const file = pathlib.join(dir, url);
    return pathlib.normalize(file);
  }

  // Search and replace a single reference file.
  // All digest urls encountered will be mapped to a real file,
  // the file will be hashed and renamed with its hash,
  // and the url will be rewritten to include the hash.
  _replaceFileDigests(file, digestMap) {
    // Reset the pattern's internal match tracker
    this.options.pattern.lastIndex = 0;
    const contents = fs.readFileSync(file, 'UTF-8');
    const self = this;
    const replacement = contents.replace(this.options.pattern, function(digest, url) {
      const hash = self._hashFromUrl(url, file, digestMap);
      let urlWithHash = self._addHashToPath(url, hash);

      if ((self.options.prependHost != null ? self.options.prependHost[self.config.env[0]] : undefined) != null) {
        urlWithHash = self.options.prependHost[self.config.env[0]] + urlWithHash;
      }

      if (self.options.discardNonFilenamePatternParts) {
        return urlWithHash;
      } else {
        return digest.replace(url, urlWithHash);
      }
    });

    return fs.writeFileSync(file, replacement);
  }

  // We're moving files and keeping their hashes as we go.
  // Returns the hash of a file.
  // Computes the hash and renames the file if needed.
  _hashFromUrl(url, referencedFrom, digestMap) {
    const file = this._fileFromUrl(url, referencedFrom);
    if (digestMap[file] === undefined) {
      if (this._validDigestFile(file)) {
        const hash = this._calculateHash(file);
        this._moveFile(file, hash);
        digestMap[file] = hash;
      } else {
        digestMap[file] = null;
      }
    }
    return digestMap[file];
  }

  _calculateHash(file) {
    const data = fs.readFileSync(file);
    const shasum = crypto.createHash('sha1');
    shasum.update(data);
    return shasum.digest('hex').slice(0, +(this.options.precision-1) + 1 || undefined);
  }

  _moveFile(file, hash) {
    const newFile = this._addHashToPath(file, hash);
    fs.renameSync(file, newFile);

    return (() => {
      const result = [];
      for (let infix of Array.from(this.options.infixes)) {
        const infixFile = this._addInfixToPath(file, infix);
        if (fs.existsSync(infixFile)) {
          const newInfixFile = this._addInfixToPath(newFile, infix);
          result.push(fs.renameSync(infixFile, newInfixFile));
        } else {
          result.push(undefined);
        }
      }
      return result;
    })();
  }

  _validDigestFile(file) {
    if (!fs.existsSync(file)) {
      warn(`Missing hashed version of file ${file}. Skipping.`);
      return false;
    }
    return fs.statSync(file).isFile();
  }

  _addHashToPath(path, hash) {
    if (hash) {
      const dir = pathlib.dirname(path);
      const ext = pathlib.extname(path);
      const base = pathlib.basename(path, ext);
      const newName = `${base}-${hash}${ext}`;
      return pathlib.posix.join(dir, newName);
    } else {
      return path;
    }
  }

  _addInfixToPath(path, infix) {
    const dir = pathlib.dirname(path);
    const ext = pathlib.extname(path);
    const base = pathlib.basename(path, ext);
    const newName = `${base}${infix}${ext}`;
    return pathlib.posix.join(dir, newName);
  }

  _writeManifestFile(renameMap) {
    if (!this.options.manifest) {
      return;
    }
    const manifest = {};
    for (let file in renameMap) {
      const hash = renameMap[file];
      if (hash) {
        const relative = pathlib.relative(this.publicFolder, file).replace(/\\/g, '/');
        const rename = this._addHashToPath(relative, hash);
        manifest[relative] = rename;
      }
    }
    return fs.writeFileSync(this.options.manifest, JSON.stringify(manifest, null, 4));
  }
}
Digest.initClass();


Digest.logger = console;

module.exports = Digest;
