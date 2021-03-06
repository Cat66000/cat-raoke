// Based on https://github.com/discordjs/voice/tree/main/examples/music-bot

import {
  AudioPlayer,
  AudioPlayerState,
  AudioPlayerStatus,
  AudioResource,
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  VoiceConnection,
  VoiceConnectionDisconnectReason,
  VoiceConnectionState,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Track } from "./track.js";
import { promisify } from "node:util";
import {
  CommandInteraction,
  Guild,
  GuildChannelManager,
  GuildMember,
  GuildTextBasedChannel,
  Snowflake,
  VoiceChannel,
} from "discord.js";

const wait = promisify(setTimeout);

export const subscriptions = new Map<Snowflake, MusicSubscription>();

export const joinVCAndCreateSubscription = async (
  subscription: void | MusicSubscription,
  interaction: CommandInteraction,
): Promise<void | MusicSubscription> => {
  if (!subscription) {
    if (
      interaction.member instanceof GuildMember &&
      interaction.member.voice.channel
    ) {
      const voiceChannel = interaction.member.voice.channel;

      subscription = new MusicSubscription(
        joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guildId,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        }),
        {
          textChannelId: interaction.channelId,
          guildChannels: (interaction.guild as Guild).channels,
          voiceChannelId: voiceChannel.id,
        },
      );

      subscription.voiceConnection.on("error", console.warn);
      subscriptions.set(interaction.guildId as string, subscription);
    }

    if (!subscription) {
      await interaction.followUp(
        "Rejoins un salon vocal et ensuite essaye à nouveau ^^",
      );
      return;
    }

    try {
      await entersState(
        subscription.voiceConnection,
        VoiceConnectionStatus.Ready,
        20e3,
      );
    } catch (err) {
      console.warn(err);
      await interaction.followUp(
        "Je n'ai pas réussi à rejoindre le salon vocal dans les 20 secondes, veuillez réessayer plus tard",
      );
      return;
    }

    await interaction.followUp(
      `J'ai rejoint le salon vocal \`${
        (await subscription.voiceChannel).name
      }\``,
    );
  }

  return subscription;
};
/**
 * A MusicSubscription exists for each active VoiceConnection. Each subscription has its own audio player and queue,
 * and it also attaches logic to the audio player and voice connection for error handling and reconnection logic.
 */
export class MusicSubscription {
  public readonly guildChannels: GuildChannelManager;
  public readonly textChannelId: Snowflake;
  public readonly voiceChannelId: Snowflake;

  public readonly voiceConnection: VoiceConnection;
  public readonly audioPlayer: AudioPlayer;
  public queue: Track[];
  public queueLock = false;
  public readyLock = false;

  public constructor(
    voiceConnection: VoiceConnection,
    options: {
      voiceChannelId: Snowflake;
      textChannelId: Snowflake;
      guildChannels: GuildChannelManager;
    },
  ) {
    this.voiceChannelId = options.voiceChannelId;
    this.textChannelId = options.textChannelId;
    this.guildChannels = options.guildChannels;

    this.voiceConnection = voiceConnection;
    this.audioPlayer = createAudioPlayer();
    this.queue = [];

    this.voiceConnection.on(
      // @ts-ignore
      "stateChange",
      async (_: any, newState: VoiceConnectionState) => {
        if (newState.status === VoiceConnectionStatus.Disconnected) {
          if (
            newState.reason ===
              VoiceConnectionDisconnectReason.WebSocketClose &&
            newState.closeCode === 4014
          ) {
            /**
             * If the WebSocket closed with a 4014 code, this means that we should not manually attempt to reconnect,
             * but there is a chance the connection will recover itself if the reason of the disconnect was due to
             * switching voice channels. This is also the same code for the bot being kicked from the voice channel,
             * so we allow 5 seconds to figure out which scenario it is. If the bot has been kicked, we should destroy
             * the voice connection.
             */
            try {
              await entersState(
                this.voiceConnection,
                VoiceConnectionStatus.Connecting,
                5_000,
              );
              // Probably moved voice channel
            } catch {
              this.voiceConnection.destroy();
              // Probably removed from voice channel
            }
          } else if (this.voiceConnection.rejoinAttempts < 5) {
            /**
             * The disconnect in this case is recoverable, and we also have <5 repeated attempts so we will reconnect.
             */
            await wait((this.voiceConnection.rejoinAttempts + 1) * 5_000);
            this.voiceConnection.rejoin();
          } else {
            /**
             * The disconnect in this case may be recoverable, but we have no more remaining attempts - destroy.
             */
            this.voiceConnection.destroy();
          }
        } else if (newState.status === VoiceConnectionStatus.Destroyed) {
          /**
           * Once destroyed, stop the subscription.
           */
          this.stop();
        } else if (
          !this.readyLock &&
          (newState.status === VoiceConnectionStatus.Connecting ||
            newState.status === VoiceConnectionStatus.Signalling)
        ) {
          /**
           * In the Signalling or Connecting states, we set a 20 second time limit for the connection to become ready
           * before destroying the voice connection. This stops the voice connection permanently existing in one of these
           * states.
           */
          this.readyLock = true;
          try {
            await entersState(
              this.voiceConnection,
              VoiceConnectionStatus.Ready,
              20_000,
            );
          } catch {
            if (
              this.voiceConnection.state.status !==
                VoiceConnectionStatus.Destroyed
            ) {
              this.voiceConnection.destroy();
            }
          } finally {
            this.readyLock = false;
          }
        }
      },
    );

    // Configure audio player
    this.audioPlayer.on(
      // @ts-ignore
      "stateChange",
      (oldState: AudioPlayerState, newState: AudioPlayerState) => {
        if (
          newState.status === AudioPlayerStatus.Idle &&
          oldState.status !== AudioPlayerStatus.Idle
        ) {
          // If the Idle state is entered from a non-Idle state, it means that an audio resource has finished playing.
          // The queue is then processed to start playing the next track, if one is available.

          if (this.queue.length === 0) {
            this.textChannel.then((channel) =>
              channel.send("La queue est vide, aucune piste n'est jouée.")
            ).catch(this.onError);
            return;
          }
          void this.processQueue();
        } else if (newState.status === AudioPlayerStatus.Playing) {
          const songTitle =
            (newState.resource as AudioResource<Track>).metadata.data.title;

          this.textChannel.then((channel) =>
            channel.send(`En cours de lecture : \`${songTitle}\``)
          ).catch(this.onError);
        }
      },
    );

    this.audioPlayer.on(
      "error",
      (err: { resource: any }) =>
        // @ts-ignore
        this.onError(err),
    );

    voiceConnection.subscribe(this.audioPlayer);
  }

  get textChannel() {
    return (this.guildChannels.fetch(
      this.textChannelId,
    ) as Promise<GuildTextBasedChannel>);
  }

  get voiceChannel() {
    return (this.guildChannels.fetch(
      this.voiceChannelId,
    ) as Promise<VoiceChannel>);
  }

  /**
   * Adds a new Track to the queue.
   *
   * @param track The track to add to the queue
   */
  public enqueue(track: Track) {
    this.queue.push(track);
    void this.processQueue();
  }

  /**
   * Stops audio playback and empties the queue.
   */
  public stop() {
    this.queueLock = true;
    this.queue = [];
    this.audioPlayer.stop(true);
  }

  /**
   * Attempts to play a Track from the queue.
   */
  private async processQueue(): Promise<void> {
    // If the queue is locked (already being processed), is empty, or the audio player is already playing something, return
    if (
      this.queueLock ||
      this.audioPlayer.state.status !== AudioPlayerStatus.Idle
    ) {
      return;
    }

    // Lock the queue to guarantee safe access
    this.queueLock = true;

    // Take the first item from the queue. This is guaranteed to exist due to the non-empty check above.
    const nextTrack = this.queue.shift()!;
    try {
      // Attempt to convert the Track into an AudioResource (i.e. start streaming the video)
      const resource = await nextTrack.createAudioResource();
      this.audioPlayer.play(resource);
      this.queueLock = false;
    } catch (error) {
      // If an error occurred, try the next item of the queue instead
      this.onError(error);
      this.queueLock = false;

      return this.processQueue();
    }
  }

  private async onError(error: any) {
    console.warn(error);
    await (await (this.textChannel)).send(`Erreur: \`${error.message}\``);
  }
}
