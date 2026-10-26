from manim import *
import numpy as np


BACKGROUND = "#050B18"
PALETTE = ["#1D4ED8", "#2563EB", "#3B82F6", "#60A5FA", "#38BDF8", "#22D3EE"]
BARS = 15
LOOP_SECONDS = 3.0


class SurfCodeLogo(Scene):
    """A seamless, blue SurfCode lockup for the README.

    Every motion completes a whole cycle in LOOP_SECONDS, so the rendered clip
    can be looped by ffmpeg (or any video player) without a visible cut. The
    SVG fallback in scripts/generate-logo-gif.mjs follows the same layout.
    """

    def construct(self):
        self.camera.background_color = BACKGROUND

        tracker = ValueTracker(0.0)

        # Soft color wash behind the wordmark. It breathes once per loop.
        halo = Ellipse(width=7.5, height=2.2)
        halo.set_fill("#1D4ED8", opacity=0.16)
        halo.set_stroke(width=0)
        halo.move_to(UP * 0.1)
        halo.add_updater(
            lambda mob: mob.set_fill(
                opacity=0.13 + 0.035 * np.sin(tracker.get_value())
            )
        )

        word = Text(
            "SURFCODE",
            font="DejaVu Sans",
            weight=BOLD,
            font_size=86,
        )
        word.set_color_by_gradient(*PALETTE)
        word.move_to(UP * 0.22)

        rule = Line(LEFT * 3.1, RIGHT * 3.1, stroke_width=3)
        rule.set_color_by_gradient(*PALETTE)
        rule.next_to(word, DOWN, buff=0.32)

        caption = Text(
            "R I D E   T H E   C O D E",
            font="DejaVu Sans",
            weight=BOLD,
            font_size=18,
            color="#93C5FD",
        )
        caption.set_opacity(0.82)
        caption.next_to(rule, DOWN, buff=0.2)

        # A highlight rides the rule from off-screen to off-screen. Because it
        # starts and ends outside the visible line, the loop point is hidden.
        shine = Dot(radius=0.055, color=WHITE)
        shine.add_updater(
            lambda mob: mob.move_to(
                [
                    rule.get_left()[0]
                    - 0.2
                    + (tracker.get_value() / TAU) * (rule.width + 0.4),
                    rule.get_center()[1],
                    0,
                ]
            ).set_opacity(
                0.25 + 0.65 * np.sin(np.pi * (tracker.get_value() / TAU))
            )
        )

        bars = VGroup()
        total_width = BARS * 0.17
        start_x = -total_width / 2 + 0.085
        baseline = word.get_top()[1] + 0.62
        for index in range(BARS):
            bar = RoundedRectangle(width=0.075, height=0.2, corner_radius=0.0375)
            bar.set_fill(PALETTE[index % len(PALETTE)], opacity=0.95)
            bar.set_stroke(width=0)
            bar.move_to([start_x + index * 0.17, baseline + 0.1, 0])
            bar.add_updater(self.bar_updater(bar, index, baseline, tracker))
            bars.add(bar)

        self.add(halo, bars, word, rule, shine, caption)
        self.play(
            tracker.animate.set_value(TAU),
            run_time=LOOP_SECONDS,
            rate_func=linear,
        )

    @staticmethod
    def bar_updater(bar, index, baseline, tracker):
        def update(mob):
            phase = tracker.get_value()
            sway = (
                np.sin(phase + index * 0.58) * 0.62
                + np.sin(phase * 2 + index * 0.91) * 0.38
            )
            height = 0.14 + (sway + 1) * 0.5 * 0.38
            mob.stretch_to_fit_height(height)
            mob.move_to([mob.get_center()[0], baseline + height / 2, 0])

        return update
