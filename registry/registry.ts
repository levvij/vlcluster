import { Crypto } from "../crypto";
import { Cluster } from "../cluster";

import * as fs from "fs";
import * as path from "path";
import { worker } from "cluster";
import { Logger } from "../log";

export class RegistryServer {
	key: string;
	logger: Logger;

	runningWorkers: {
		name: string,
		lastSeen: Date,
		cpuUsage: number,
		up: boolean
	}[];

	proposedInstalls: {
		application: string,
		version: string,
		env: string,
		worker: string,
		installing: boolean,
		requested: boolean,
		key: string,
		instance: string,

		oncomplete(): void
	}[];

	constructor() {
		if (!RegistryServer.isInstalled()) {
			throw new Error("no registry installed on this host!");
		}

		this.key = fs.readFileSync(RegistryServer.keyFile).toString();

		this.runningWorkers = [];
		this.proposedInstalls = [];

		this.logger = new Logger("registry");
	}

	createWorker(name: string) {
		this.logger.log(`creating worker '${name}'`);

		if (fs.existsSync(RegistryServer.workerDirectory(name))) {
			throw new Error("worker already registered");
		}

		const key = Crypto.createKey();

		// create worker directory
		fs.mkdirSync(RegistryServer.workerDirectory(name));
		fs.writeFileSync(RegistryServer.workerKeyFile(name), key);

		this.logger.log(`created worker '${name}'`);

		return key;
	}

	createClient(name: string) {
		const key = Crypto.createKey();

		this.logger.log(`creating client ${name}`);

		if (fs.existsSync(RegistryServer.clientDirectory(name))) {
			throw new Error(`client '${name}' already exists!`);
		}

		fs.mkdirSync(RegistryServer.clientDirectory(name));
		fs.writeFileSync(RegistryServer.clientKeyFile(name), key);

		this.logger.log(`created client`);

		return key;
	}

	static isInstalled() {
		return fs.existsSync(RegistryServer.rootDirectory);
	}

	static async create(name: string) {
		// generate key
		const key = Crypto.createKey();

		// create registry directory
		fs.mkdirSync(RegistryServer.rootDirectory);

		// create files
		fs.writeFileSync(RegistryServer.keyFile, key);
		fs.writeFileSync(RegistryServer.nameFile, name);

		// create registry
		fs.mkdirSync(RegistryServer.workersDirectory);
		fs.mkdirSync(RegistryServer.clientsDirectory);
		fs.mkdirSync(RegistryServer.applicationsDirectory);

		return key;
	}

	static get rootDirectory() {
		return path.join(Cluster.localDirectory, "registry");
	}

	static get keyFile() {
		return path.join(this.rootDirectory, "key");
	}

	static get nameFile() {
		return path.join(this.rootDirectory, "name");
	}

	static get applicationsDirectory() {
		return path.join(this.rootDirectory, "applications");
	}

	static applicationDirectory(name: string) {
		return path.join(this.applicationsDirectory, Crypto.sanitizeApplicationName(name));
	}

	static applicationVersionsDirectory(name: string) {
		return path.join(this.applicationDirectory(name), "versions");
	}

	static applicationEnvsDirectory(name: string) {
		return path.join(this.applicationDirectory(name), "envs");
	}

	static applicationEnvDirectory(name: string, env: string) {
		return path.join(this.applicationEnvsDirectory(name), Crypto.sanitizeEnv(env));
	}

	static applicationEnvLatestVersionFile(name: string, env: string) {
		return path.join(this.applicationEnvDirectory(name, env), "latest");
	} 

	static applicationEnvDangelingVersionFile(name: string, env: string) {
		return path.join(this.applicationEnvDirectory(name, env), "dangeling");
	} 

	static applicationEnvActiveVersionsDirectory(name: string, env: string) {
		return path.join(this.applicationEnvDirectory(name, env), "active-versions");
	} 

	static applicationEnvActiveVersionDirectory(name: string, env: string, version: string) {
		return path.join(this.applicationEnvActiveVersionsDirectory(name, env), Crypto.sanitizeVersion(version));
	} 

	static applicationEnvActiveVersionWorkerDirectory(name: string, env: string, version: string, worker: string) {
		return path.join(this.applicationEnvActiveVersionDirectory(name, env, version), Crypto.sanitizeWorkerName(worker));
	} 

	static applicationEnvActiveVersionWorkerInstanceDirectory(name: string, env: string, version: string, worker: string, instance: string) {
		return path.join(this.applicationEnvActiveVersionWorkerDirectory(name, env, version, worker), Crypto.sanitizeInstanceName(instance));
	} 

	static applicationEnvActiveVersionWorkerInstancePortFile(name: string, env: string, version: string, worker: string, instance: string) {
		return path.join(this.applicationEnvActiveVersionWorkerInstanceDirectory(name, env, version, worker, instance), "port");
	} 

	static applicationVersionDirectory(name: string, version: string) {
		return path.join(this.applicationVersionsDirectory(name), Crypto.sanitizeVersion(version));
	}

	static applicationVersionImageSourceFile(name: string, version: string) {
		return path.join(this.applicationVersionDirectory(name, version), "source");
	}

	static applicationVersionImageIdFile(name: string, version: string) {
		return path.join(this.applicationVersionDirectory(name, version), "id");
	}

	static get workersDirectory() {
		return path.join(this.rootDirectory, "workers");
	}

	static workerDirectory(name: string) {
		return path.join(this.workersDirectory, Crypto.sanitizeWorkerName(name));
	}

	static workerKeyFile(name: string) {
		return path.join(this.workerDirectory(name), "key");
	}

	static get clientsDirectory() {
		return path.join(this.rootDirectory, "clients");
	}

	static clientDirectory(name: string) {
		return path.join(this.clientsDirectory, Crypto.sanitizeUsername(name));
	}

	static clientKeyFile(name: string) {
		return path.join(this.clientDirectory(name), "key");
	}

	get name() {
		return fs.readFileSync(RegistryServer.nameFile).toString();
	}

	register(app) {
		app.post(Cluster.api.registry.createWorker, (req, res) => {
			if (this.key != req.body.key) {
				throw new Error(`invalid key login attepted`);
			}

			const key = this.createWorker(req.body.name);

			res.json({
				key: key,
				name: this.name
			});
		});

		app.post(Cluster.api.registry.createClient, (req, res) => {
			if (this.key != req.body.key) {
				throw new Error(`invalid key login attepted`);
			}

			const key = this.createClient(req.body.username);

			res.json({
				key,
				name: this.name
			});
		});

		app.post(Cluster.api.registry.push, async (req, res) => {
			await this.validateClientAuth(req);

			const application = req.headers["cluster-application"];
			const version = req.headers["cluster-version"];
			const imageName = req.headers["cluster-image-name"];

			if (!application) {
				throw new Error(`no application name!`);
			}

			if (!version) {
				throw new Error(`no version!`);
			}

			this.logger.log("create ", this.logger.av(application, version));

			if (!fs.existsSync(RegistryServer.applicationDirectory(application))) {
				this.logger.log(`create new application '${application}'`);

				fs.mkdirSync(RegistryServer.applicationDirectory(application));
				fs.mkdirSync(RegistryServer.applicationVersionsDirectory(application));
				fs.mkdirSync(RegistryServer.applicationEnvsDirectory(application));
			}

			if (fs.existsSync(RegistryServer.applicationVersionDirectory(application, version))) {
				throw new Error(`version '${version}' of application '${application}' already exists!`);
			}

			fs.mkdirSync(RegistryServer.applicationVersionDirectory(application, version));
			fs.writeFileSync(RegistryServer.applicationVersionImageIdFile(application, version), imageName);

			this.logger.log("receiving ", this.logger.av(application, version), " image...");
			req.pipe(fs.createWriteStream(RegistryServer.applicationVersionImageSourceFile(application, version)));

			req.on("end", () => {
				this.logger.log("saved ", this.logger.av(application, version), " image");

				res.json({});
			})
		});

		app.post(Cluster.api.registry.upgrade, async (req, res) => {
			await this.validateClientAuth(req);

			const env = req.headers["cluster-env"];
			const application = req.headers["cluster-application"];
			const version = req.headers["cluster-version"];

			if (!fs.existsSync(RegistryServer.applicationVersionDirectory(application, version))) {
				throw new Error("application or version does not exist!");
			}

			this.logger.log(`upgrading '${application}' to v${version}`);
			await this.upgrade(application, version, env);

			res.json({});
		});

		app.post(Cluster.api.registry.ping, (req, res) => {
			const name = req.body.name;
			const key = req.body.key;
			const cpuUsage = req.body.cpuUsage;

			const installRequests = [];

			if (!name) {
				throw new Error("no name!");
			}

			if (key != fs.readFileSync(RegistryServer.workerKeyFile(name)).toString()) {
				throw new Error("invalid key!");
			}

			let worker = this.runningWorkers.find(s => s.name == name);
			const now = new Date();

			if (!worker) {
				worker = {
					name,
					cpuUsage,
					lastSeen: now,
					up: true
				};

				this.runningWorkers.push(worker);
				this.logger.log(`worker login '${name}'`);
			} else {
				worker.cpuUsage = cpuUsage;
				worker.lastSeen = now;
				worker.up = true;
			}

			for (let proposal of this.proposedInstalls) {
				if (proposal.worker == worker.name) {
					if (proposal.requested) {
						proposal.installing = true;
					} else {
						this.logger.log("sent proposal ", this.logger.aev(proposal.application, proposal.env, proposal.version), " to ", this.logger.w(worker.name));

						installRequests.push({
							application: proposal.application,
							version: proposal.version,
							env: proposal.env,
							key: proposal.key,
							instance: Crypto.createKey(),
							imageId: fs.readFileSync(RegistryServer.applicationVersionImageIdFile(proposal.application, proposal.version)).toString()
						});

						proposal.requested = true;

						setTimeout(() => {
							if (proposal.requested && !proposal.installing) {
								this.logger.log("install request ", this.logger.aev(proposal.application, proposal.env, proposal.version), " to ", this.logger.w(worker.name), " timed out");

								// remvoe failed install request
								this.proposedInstalls.splice(this.proposedInstalls.indexOf(proposal), 1);

								// create new proposal 
								this.proposeInstall(proposal.application, proposal.version, proposal.env);
							}
						}, Cluster.imageInstallRequestTimeout);
					}
				}
			}

			setTimeout(() => {
				if (worker.lastSeen == now) {
					this.logger.log(this.logger.w(name), " ping timed out");

					worker.up = false;

					for (let proposal of this.proposedInstalls) {
						if (!proposal.installing && proposal.worker == worker.name) {
							this.logger.log("proposal ", this.logger.aev(proposal.application, proposal.env, proposal.version), " for ", this.logger.w(worker.name), " timed out");

							// remvoe failed proposal
							this.proposedInstalls.splice(this.proposedInstalls.indexOf(proposal), 1);

							// create new proposal 
							this.proposeInstall(proposal.application, proposal.version, proposal.env);
						}
					}
				}
			}, Cluster.pingTimeout);

			res.json({
				installRequests
			});
		});

		app.post(Cluster.api.registry.pull, (req, res) => {
			const key = req.headers["cluster-key"];
			
			const request = this.proposedInstalls.find(s => s.key == key);

			if (!request) {
				throw new Error("no install found!");
			}

			request.installing = true;

			this.logger.log("sending ", this.logger.av(request.application, request.version));
			
			console.warn(`sending '${request.application}' v${request.version} image to '${request.worker}'`);
			fs.createReadStream(RegistryServer.applicationVersionImageSourceFile(request.application, request.version)).pipe(res);
		});

		app.post(Cluster.api.registry.startedApplication, (req, res) => {
			const proposal = this.proposedInstalls.find(i => i.instance == req.headers["cluster-instance"]);

			this.logger.log(this.logger.aev(proposal.application, proposal.env, proposal.version), " started on ", this.logger.w(proposal.worker));

			proposal.oncomplete();
		});

		setInterval(() => {
			process.stdout.write(`\u001b[2m[ cluster ]\t${this.runningWorkers.length ? this.runningWorkers.map(
				w => `${w.up ? "\u001b[2m✔" : "\u001b[31m✗"} ${w.name}: ${w.cpuUsage.toFixed(1).padStart(5, " ")}%\u001b[0m`
			).join("\u001b[2m, \u001b[0m") : "no running workers"}\u001b[0m\n`);
		}, Cluster.pingInterval);
	}

	async upgrade(application: string, version: string, env: string) {
		this.logger.log("upgrade ", this.logger.aev(application, env, version));
		
		if (!fs.existsSync(RegistryServer.applicationEnvDirectory(application, env))) {
			fs.mkdirSync(RegistryServer.applicationEnvDirectory(application, env));

			this.logger.log("new env ", this.logger.ae(application, env));
		}

		if (fs.existsSync(RegistryServer.applicationEnvDangelingVersionFile(application, env))) {
			throw new Error("cannot upgrade. upgrade already in progress!");
		}

		let dangelingVersion;
		
		if (fs.existsSync(RegistryServer.applicationEnvLatestVersionFile(application, env))) {
			dangelingVersion = fs.readFileSync(RegistryServer.applicationEnvLatestVersionFile(application, env)).toString();

			fs.writeFileSync(RegistryServer.applicationEnvDangelingVersionFile(application, env), dangelingVersion);
		} 
		

		const installs = await this.proposeInstall(application, version, env);
	}

	proposeInstall(application: string, version: string, env: string) {
		return new Promise(done => {
			const worker = this.runningWorkers.filter(w => w.up).sort((a, b) => a.cpuUsage - b.cpuUsage)[0];

			if (!worker) {
				console.warn(`[ cluster ]\tout of workers to run '${application}' v${version} for env '${env}'. retrying in ${Math.round(Cluster.pingInterval / 1000)}s`);

				setTimeout(async () => {
					done(await this.proposeInstall(application, version, env));
				}, Cluster.pingInterval);

				return;
			}

			console.log(`[ cluster ]\tproposed '${application}' v${version} for env '${env}' proposed to run on '${worker.name}'`);

			const proposal = {
				application,
				version,
				env,
				worker: worker.name,
				installing: false,
				requested: false,
				instance: Crypto.createKey(),
				key: Crypto.createKey(),
				oncomplete: () => done(proposal)
			};

			this.proposedInstalls.push(proposal);
		});
	}

	async validateClientAuth(req) {
		const username = req.headers["cluster-auth-username"];
		const key = req.headers["cluster-auth-key"];

		return new Promise<void>(done => {
			setTimeout(() => {
				if (!username || !fs.existsSync(RegistryServer.clientDirectory(username))) {
					throw new Error("user does not exist!");
				}
		
				if (fs.readFileSync(RegistryServer.clientKeyFile(username)).toString() != key) {
					throw new Error("invalid key!");
				}

				done();
			}, 500);
		});
	}
}